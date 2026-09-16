// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title NameRegistry - names to addresses.
/// @notice A lookup laid ON TOP OF mesh identity, never a namespace beside it
/// (spec S0). Two kinds of name live here:
///   * a CANONICAL name is a qualified agent id, `<org label>:<local id>`,
///     registered by chain-svc at spawn with owner == target == the wallet;
///   * a VANITY alias (`vendor.play`) is any other name owned by a wallet
///     that already has a canonical name.
/// @dev The registry deliberately CANNOT tell the two apart. The rule "exactly
/// one colon iff canonical" is enforced in chain-svc (400 invalid_name), not
/// here (spec S3.2), which is why there is a single `registerFor` entry point
/// rather than a canonical/alias split. Keep it that way: putting the colon
/// rule on-chain would freeze a game-layer distinction into the ABI.
contract NameRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    uint256 private constant MIN_NAME_LENGTH = 3;
    uint256 private constant MAX_NAME_LENGTH = 48;

    struct Record {
        address owner;
        address target;
    }

    /// @notice name key (keccak256 of the name bytes) => record.
    mapping(bytes32 => Record) public records;

    /// @notice One primary name per address, keyed by TARGET - not by owner -
    /// and written only by `registerFor`.
    /// @dev ruled on spec S3.2: a Record has both an owner and a
    /// target and at spawn they are the same wallet, so which one the reverse
    /// follows is not self-evident. It follows the TARGET, because reverseOf
    /// answers "what is the name of the thing AT this address".
    mapping(address => bytes32) public reverse;

    /// @dev key => the name as given. Needed because reverseOf returns the
    /// string, and a keccak key cannot be turned back into one.
    mapping(bytes32 => string) private _names;

    event Registered(string name, address owner, address target);
    event Transferred(string name, address from, address to);
    /// @dev Not in the original S3.2 list. Retirement (`DELETE /wallets`) works
    /// by clearing alias targets, and chain-svc indexes aliases from events -
    /// without this the off-chain index keeps serving an alias whose target is
    /// gone. Flagged for ratification in the 1a PR.
    event TargetChanged(string name, address from, address to);

    error NameTaken();
    error NameTooShort();
    error NameTooLong();
    error InvalidNameChar(uint256 index, bytes1 char);
    error NotOwner();
    /// @dev Not in the original S3.2 list either. Without it setTargetFor -
    /// which has no owner check, being registrar-only - would happily write a
    /// target for a name nobody registered, creating a phantom record owned by
    /// address(0). Flagged for ratification in the 1a PR.
    error UnknownName();
    /// @dev A record whose owner is address(0) reads as UNREGISTERED to every
    /// check in this contract (`_requireExisting`, the NameTaken guard), while
    /// still having captured `reverse[target]`. So a zero-owner registration
    /// leaves a name that anyone can re-register while the original target's
    /// primary name still points at it. A zero TARGET is refused for the
    /// mirror reason: it would write a reverse entry for the zero address and
    /// resolve to "unknown" while occupying the name.
    ///
    /// Zero is still a legitimate TARGET for setTarget/setTargetFor - that is
    /// how retirement clears an alias (spec S4) - so the check belongs on the
    /// registration paths only, not on repointing.
    error ZeroAddress();

    /// @param admin receives DEFAULT_ADMIN_ROLE and REGISTRAR_ROLE: chain-svc's
    /// treasury key, which names orgs and operators at spawn (spec S3.2).
    constructor(address admin) {
        // A registry deployed with no admin has no registrar and can never be
        // given one: every name in the game would be unregisterable and the
        // only fix is redeploying, after balances exist.
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    /// @notice Register `name`, with the caller as its owner. FORWARD-ONLY.
    /// @dev REGISTRAR-ONLY (ruled) as well as forward-only (ruled).
    ///
    /// Forward-only was not enough. Names are unique and a canonical id is
    /// publicly derivable from an org label and a local id BEFORE the agent it
    /// belongs to exists, so a stranger could take `orch:victim` pointing at
    /// themselves. The treasury's registerFor at spawn then reverts NameTaken
    /// for ever, and until anyone noticed, `resolve("orch:victim")` returned
    /// the attacker - so every wallet_send addressed to that name paid THEM.
    /// Nor is it recoverable by repointing: setTargetFor moves the target, the
    /// attacker owns the name and moves it back, and transfer reverts NotOwner,
    /// so the registrar can never win the contest.
    ///
    /// That is theft and spawn denial, not the reporting corruption I first
    /// assessed this family as. My reasoning was that chain-svc composes
    /// canonical ids rather than reading them - true for KEYING, and irrelevant
    /// to RESOLUTION, which is what a transfer destination goes through.
    ///
    /// The game never used permissionless registration (the Broker calls
    /// registerFor after a purchase), so the modifier costs nothing.
    function register(string calldata name, address target) external onlyRole(REGISTRAR_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        _register(name, msg.sender, target, false);
    }

    /// @notice Register `name` on someone else's behalf. Used by chain-svc at
    /// spawn for canonical ids, and by the Broker after a purchase.
    function registerFor(string calldata name, address owner, address target)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (owner == address(0) || target == address(0)) revert ZeroAddress();
        // The ONLY path that may write a primary name.
        _register(name, owner, target, true);
    }

    /// @notice Hand a name to a new owner. Owner only; in-game this is a
    /// purchase the Broker executes with the previous owner's org key.
    function transfer(string calldata name, address newOwner) external {
        // transfer(name, address(0)) would otherwise be a silent RELEASE: the
        // record stays, resolve() keeps working, but every ownership check
        // reads the name as unregistered, so anyone can re-register it.
        if (newOwner == address(0)) revert ZeroAddress();

        bytes32 key = _requireExisting(name);
        Record storage rec = records[key];
        if (rec.owner != msg.sender) revert NotOwner();

        address previousOwner = rec.owner;
        rec.owner = newOwner;

        // "clears old reverse if it pointed here" (spec S3.2): a name that has
        // changed hands must stop being the primary name of the address it
        // still targets, or a sold alias keeps answering reverseOf for its
        // previous owner.
        if (reverse[rec.target] == key) {
            delete reverse[rec.target];
        }

        emit Transferred(name, previousOwner, newOwner);
    }

    /// @notice Repoint a name. Owner only.
    function setTarget(string calldata name, address target) external {
        bytes32 key = _requireExisting(name);
        if (records[key].owner != msg.sender) revert NotOwner();
        _setTarget(key, name, target);
    }

    /// @notice Repoint a name as the registrar, without the owner's key.
    /// @dev Exists so retirement is a platform action: `DELETE /wallets` clears
    /// the targets of an agent's aliases, and must not depend on that agent's
    /// keystore entry still being decryptable (ruled on spec S3.2).
    function setTargetFor(string calldata name, address target)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        bytes32 key = _requireExisting(name);
        _setTarget(key, name, target);
    }

    /// @notice Address a name points at, or address(0) if the name is unknown.
    /// @dev Views never revert on a miss (ruled): chain-svc needs
    /// "unknown" as a value it can turn into a 404, not a decode error.
    function resolve(string calldata name) external view returns (address) {
        return records[keccak256(bytes(name))].target;
    }

    /// @notice Primary name of `addr`, or "" if it has none.
    function reverseOf(address addr) external view returns (string memory) {
        return _names[reverse[addr]];
    }

    function _register(string calldata name, address owner, address target, bool mayWriteReverse) private {
        _validateName(name);

        bytes32 key = keccak256(bytes(name));
        if (records[key].owner != address(0)) revert NameTaken();

        records[key] = Record({owner: owner, target: target});
        _names[key] = name;

        // The reverse is written HERE AND NOWHERE ELSE, only from registerFor,
        // and only when the target has no primary name yet - so a vanity alias
        // can never overwrite the canonical id, and the permissionless path can
        // never write one at all (spec S3.2, ruled).
        //
        // Deliberately NOT `owner == target`, which was the first fix proposed:
        // that would still let a self-owned first registration become primary,
        // and S0 says a primary name is the registrar's canonical id or nothing.
        //
        // No zero-address guard: both entry points refuse a zero target before
        // reaching this, and an unreachable branch would report as uncovered
        // while proving nothing.
        // AND THE CONSEQUENCE OF "only when empty", stated because it is not
        // visible from this line (reviewer's observation; no behaviour change).
        //
        // `reverse[target]` is CLEARED in two places - `transfer`, when a name
        // changes hands, and `setTarget`, when it moves away - and it is only
        // ever written here, on a registration, and only into an empty slot. So
        // an address whose primary name was cleared has NO primary name until
        // something registers a new one for it, and the NEXT registerFor for
        // that address takes the slot whatever name it carries.
        //
        // chain-svc never exercises that: it registers the canonical id first
        // and an alias only afterwards, so the canonical always wins the empty
        // slot. The consequence is for anything else holding the registrar
        // role - register a vanity alias for an address whose primary was
        // cleared and the alias BECOMES that address's primary name, and
        // `reverseOf` answers with it.
        //
        // Left as it is deliberately: the alternative is re-writing `reverse`
        // on retarget, which is the promotion this design exists to prevent
        // (see setTarget). The rule that keeps it safe is the ORDER a registrar
        // registers in, and that rule lives in the caller.
        if (mayWriteReverse && reverse[target] == bytes32(0)) {
            reverse[target] = key;
        }

        emit Registered(name, owner, target);
    }

    function _setTarget(bytes32 key, string calldata name, address target) private {
        Record storage rec = records[key];
        address previousTarget = rec.target;
        rec.target = target;

        // Cleared when the target moves away, and deliberately NOT re-written
        // for the new target: the reverse is written on register only. If this
        // adopted the new target, retiring an alias would promote that alias to
        // be somebody's primary name.
        if (reverse[previousTarget] == key) {
            delete reverse[previousTarget];
        }

        emit TargetChanged(name, previousTarget, target);
    }

    function _requireExisting(string calldata name) private view returns (bytes32 key) {
        key = keccak256(bytes(name));
        if (records[key].owner == address(0)) revert UnknownName();
    }

    /// @dev Length and charset are enforced on-chain (spec S3.2); the colon
    /// rule is not (see the contract notice). Names are stored AS GIVEN: no
    /// normalisation and no lookalike checks, because phishing-by-name is a
    /// game mechanic - `aIpha.play` (capital i) and `alpha.play` (lowercase L)
    /// are two different, equally valid names, and telling them apart is the
    /// UI's job. That is precisely why the charset admits A-Z: see the 1a PR.
    function _validateName(string calldata name) private pure {
        bytes calldata raw = bytes(name);
        uint256 len = raw.length;
        if (len < MIN_NAME_LENGTH) revert NameTooShort();
        if (len > MAX_NAME_LENGTH) revert NameTooLong();

        for (uint256 i = 0; i < len; i++) {
            bytes1 c = raw[i];
            bool ok = (c >= 0x61 && c <= 0x7a) // a-z
                || (c >= 0x41 && c <= 0x5a) // A-Z
                || (c >= 0x30 && c <= 0x39) // 0-9
                || c == 0x2e // .
                || c == 0x5f // _
                || c == 0x40 // @
                || c == 0x3a // :
                || c == 0x2d; // -
            if (!ok) revert InvalidNameChar(i, c);
        }
    }
}
