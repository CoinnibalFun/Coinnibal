// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {CoinnibalArena} from "../contracts/CoinnibalArena.sol";

/// @notice Test helper: join permits (`CoinnibalArena.join`'s EIP-712 `JoinPermit`) signed with a test key. The
///         digest is built here from the arena's documented domain (name, version, chainId, verifyingContract), not
///         read from the contract, so a test also checks that the contract hashes what wallets and the server sign.
library JoinPermits {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice What the game server issues: about ten minutes of validity.
    uint64 internal constant TTL = 10 minutes;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("JoinPermit(address player,uint16 arenaId,uint64 nonce,uint64 deadline)");

    struct Permit {
        uint64 deadline;
        bytes sig;
    }

    /// @notice The private key `makeAddr(name)` uses (forge-std's `makeAddrAndKey`).
    function keyOf(string memory name) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(name)));
    }

    function domain(address arena, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("CoinnibalArena"), keccak256("4"), chainId, arena));
    }

    function digest(address arena, uint256 chainId, address player, uint16 arenaId, uint64 nonce, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, player, arenaId, nonce, deadline));
        return keccak256(abi.encodePacked(hex"1901", domain(arena, chainId), structHash));
    }

    /// @notice A signature by `key` over any permit fields, for any arena address and chain (the negative tests).
    function sign(
        uint256 key,
        address arena,
        uint256 chainId,
        address player,
        uint16 arenaId,
        uint64 nonce,
        uint64 deadline
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest(arena, chainId, player, arenaId, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    /// @notice The permit the server would give `player` for `arenaId` now (its current nonce, `TTL` ahead). Reads the
    ///         nonce from the arena: call it before `vm.prank`, never between a prank and the join.
    function permit(CoinnibalArena a, uint256 key, address player, uint16 arenaId)
        internal
        view
        returns (Permit memory p)
    {
        p.deadline = uint64(block.timestamp) + TTL;
        p.sig = sign(key, address(a), block.chainid, player, arenaId, a.joinNonce(player), p.deadline);
    }
}
