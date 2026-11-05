// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ElymumArena} from "../contracts/ElymumArena.sol";
import {BlockingToken, BurnableMock} from "../contracts/test/MockTokens.sol";

/// @notice Drives an arena with random joins, settlements (any payout), cancels, refunds, collects, loot burns, rate
///         changes and blocked transfers, keeping a ghost ledger of every session it opened.
contract ArenaHandler is Test {
    ElymumArena public arena;
    BlockingToken public token;
    address public server;
    address public admin;
    uint16 public constant ID = 1;
    uint16 public constant ID2 = 2;
    uint128 public constant FEE = 1_000 ether;

    address[] public players;
    uint64 public sweepId;
    /// @dev ghost: Σ owed of finalized sessions the handler knows about.
    uint256 public ghostOwed;
    uint256 public ghostFeeBurned;
    uint256 public ghostFeeToVault;
    uint256 public ghostLootBurned;

    constructor(ElymumArena a, BlockingToken t, address s, address ad) {
        arena = a;
        token = t;
        server = s;
        admin = ad;
        for (uint256 i; i < 8; ++i) {
            address p = address(uint160(0xC000 + i));
            players.push(p);
            t.mint(p, 1_000_000 ether);
            vm.prank(p);
            t.approve(address(a), type(uint256).max);
        }
    }

    function _p(uint256 seed) internal view returns (address) {
        return players[seed % players.length];
    }

    function _id(uint256 seed) internal pure returns (uint16) {
        return seed % 2 == 0 ? ID : ID2;
    }

    function join(uint256 who, uint256 which) external {
        address p = _p(who);
        uint16 id = _id(which);
        if (arena.getSession(id, p).id != 0) return;
        vm.prank(p);
        arena.join(id);
    }

    function settle(uint256 who, uint256 which, uint256 payout, bool blocked) external {
        address p = _p(who);
        uint16 id = _id(which);
        ElymumArena.SessionView memory s = arena.getSession(id, p);
        if (s.id == 0 || s.finalized) return;
        uint128 vault = arena.getArena(id).vault;
        uint128 pay = uint128(bound(payout, 0, vault));
        token.setBlocked(p, blocked);
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](1);
        items[0] = ElymumArena.Settlement(id, p, s.id, pay);
        (uint128 net, uint128 burned, uint128 toVault) = arena.computeFees(s.entryFee, pay, s.burnBps, s.vaultBps);
        vm.prank(server);
        arena.settle(items);
        token.setBlocked(p, false);
        if (blocked && net != 0) ghostOwed += net;
        ghostFeeBurned += burned;
        ghostFeeToVault += toVault;
    }

    function cancel(uint256 who, uint256 which, bool blocked) external {
        address p = _p(who);
        uint16 id = _id(which);
        ElymumArena.SessionView memory s = arena.getSession(id, p);
        if (s.id == 0 || s.finalized || arena.getArena(id).vault < s.entryFee) return;
        token.setBlocked(p, blocked);
        ElymumArena.SessionRef[] memory items = new ElymumArena.SessionRef[](1);
        items[0] = ElymumArena.SessionRef(id, p, s.id);
        vm.prank(server);
        arena.cancel(items);
        token.setBlocked(p, false);
        if (blocked) ghostOwed += s.entryFee;
    }

    function refund(uint256 who, uint256 which, uint256 wait) external {
        address p = _p(who);
        uint16 id = _id(which);
        ElymumArena.SessionView memory s = arena.getSession(id, p);
        if (s.id == 0) return;
        if (!s.finalized) {
            vm.warp(block.timestamp + bound(wait, 0, 2 days));
            if (block.timestamp < s.openedAt + 1 days) return;
        } else {
            ghostOwed -= s.owed;
        }
        vm.prank(p);
        arena.refund(id);
    }

    function burnLoot(uint256 which, uint256 amount) external {
        uint16 id = _id(which);
        uint128 vault = arena.getArena(id).vault;
        uint128 amt = uint128(bound(amount, 0, vault / 4));
        vm.prank(server);
        arena.sweepLoot(id, ++sweepId, amt);
        ghostLootBurned += amt;
    }

    function setRates(uint16 burnBps, uint16 vaultBps) external {
        burnBps = uint16(bound(burnBps, 0, 2_500));
        vaultBps = uint16(bound(vaultBps, 0, 2_500 - burnBps));
        vm.prank(admin);
        arena.setFeeRates(burnBps, vaultBps);
    }

    function playersLength() external view returns (uint256) {
        return players.length;
    }
}

/// @notice Invariants of ElymumArena v3 under random use.
contract ElymumArenaInvariantTest is Test {
    ElymumArena internal arena;
    BlockingToken internal token;
    ArenaHandler internal handler;
    address internal admin = makeAddr("admin");
    address internal server = makeAddr("server");
    address internal feeWallet = makeAddr("feeWallet");
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new BlockingToken();
        arena = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        arena.setToken(address(token));
        arena.createArena(1, 1_000 ether, 2_000);
        arena.createArena(2, 50 ether, 2_000);
        vm.stopPrank();
        handler = new ArenaHandler(arena, token, server, admin);
        targetContract(address(handler));
    }

    /// The contract holds exactly the open vaults plus what finalized players are owed.
    function invariant_balanceIsVaultsPlusOwed() public view {
        ElymumArena.ArenaView memory a1 = arena.getArena(1);
        ElymumArena.ArenaView memory a2 = arena.getArena(2);
        assertEq(token.balanceOf(address(arena)), uint256(a1.vault) + a1.owed + a2.vault + a2.owed);
    }

    /// Σ owed of the arenas equals the ghost Σ owed of the finalized sessions.
    function invariant_owedMatchesSessions() public view {
        assertEq(uint256(arena.getArena(1).owed) + arena.getArena(2).owed, handler.ghostOwed());
    }

    /// Every token that entered an arena is in its vault, was paid to a player, burned or sent to the fee wallet.
    function invariant_perArenaAccounting() public view {
        for (uint16 id = 1; id <= 2; ++id) {
            ElymumArena.ArenaView memory v = arena.getArena(id);
            assertEq(uint256(v.totalDeposited), uint256(v.vault) + v.totalPaidOut + v.totalBurned + v.totalFees);
        }
    }

    /// The burns and fee-wallet shares on chain match what the handler expected, and moved real tokens.
    function invariant_feesMatchAndLeftTheContract() public view {
        ElymumArena.ConfigView memory c = arena.config();
        assertEq(c.totalFeeBurned, handler.ghostFeeBurned());
        assertEq(c.totalFeeToVault, handler.ghostFeeToVault());
        assertEq(c.totalLootBurned, handler.ghostLootBurned());
        assertEq(token.balanceOf(DEAD), uint256(c.totalFeeBurned) + c.totalLootBurned);
        assertEq(token.balanceOf(feeWallet), c.totalFeeToVault);
    }

    /// Fees never exceed the cap on the profit (checked globally: Σ fees <= 25 % of Σ payouts).
    function invariant_feesWithinCap() public view {
        ElymumArena.ConfigView memory c = arena.config();
        uint256 fees = uint256(c.totalFeeBurned) + c.totalFeeToVault;
        assertLe(fees * 10_000, (uint256(c.totalPaidOut) + fees) * 2_500);
    }
}

/// @notice The same invariants with the token's own `burn()` (supply really goes down).
contract ElymumArenaBurnCallInvariantTest is Test {
    ElymumArena internal arena;
    BurnableMock internal token;
    address internal admin = makeAddr("admin");
    address internal server = makeAddr("server");
    address internal feeWallet = makeAddr("feeWallet");
    BurnHandler internal handler;

    function setUp() public {
        token = new BurnableMock();
        arena = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        arena.setToken(address(token));
        arena.setBurnMode(1);
        arena.createArena(1, 1_000 ether, 2_000);
        vm.stopPrank();
        handler = new BurnHandler(arena, token, server);
        targetContract(address(handler));
    }

    function invariant_supplyFallsByTheBurns() public view {
        ElymumArena.ConfigView memory c = arena.config();
        assertEq(token.totalSupply(), handler.minted() - c.totalFeeBurned - c.totalLootBurned);
        ElymumArena.ArenaView memory v = arena.getArena(1);
        assertEq(token.balanceOf(address(arena)), uint256(v.vault) + v.owed);
    }
}

contract BurnHandler is Test {
    ElymumArena public arena;
    BurnableMock public token;
    address public server;
    uint256 public minted;
    uint64 public sweepId;
    address[] public players;

    constructor(ElymumArena a, BurnableMock t, address s) {
        arena = a;
        token = t;
        server = s;
        for (uint256 i; i < 5; ++i) {
            address p = address(uint160(0xD000 + i));
            players.push(p);
            t.mint(p, 100_000 ether);
            minted += 100_000 ether;
            vm.prank(p);
            t.approve(address(a), type(uint256).max);
        }
    }

    function join(uint256 who) external {
        address p = players[who % players.length];
        if (arena.getSession(1, p).id != 0) return;
        vm.prank(p);
        arena.join(1);
    }

    function settle(uint256 who, uint256 payout) external {
        address p = players[who % players.length];
        ElymumArena.SessionView memory s = arena.getSession(1, p);
        if (s.id == 0) return;
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](1);
        items[0] = ElymumArena.Settlement(1, p, s.id, uint128(bound(payout, 0, arena.getArena(1).vault)));
        vm.prank(server);
        arena.settle(items);
    }

    function burnLoot(uint256 amount) external {
        uint128 amt = uint128(bound(amount, 0, arena.getArena(1).vault / 4));
        vm.prank(server);
        arena.sweepLoot(1, ++sweepId, amt);
    }
}
