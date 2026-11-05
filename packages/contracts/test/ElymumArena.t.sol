// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ElymumArena} from "../contracts/ElymumArena.sol";
import {TestToken} from "../contracts/TestToken.sol";
import {
    MockERC20,
    FeeOnTransferToken,
    BlockingToken,
    ReentrantToken,
    MockNFT,
    BrokenNFT,
    BurnableMock,
    FakeBurnToken
} from "../contracts/test/MockTokens.sol";
import {RejectEther} from "../contracts/test/Actors.sol";

/// @notice Unit and fuzz tests of ElymumArena v3 (fee on profit: 15 % burned, 5 % to the fee wallet by default).
contract ElymumArenaTest is Test {
    ElymumArena internal arena;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal server = makeAddr("server");
    address internal feeWallet = makeAddr("feeWallet");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant ID = 1;
    uint128 internal constant FEE = 1_000 ether;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    event TokenSet(address indexed token, uint8 decimals);
    event FeeRatesSet(uint16 burnBps, uint16 vaultBps);
    event HolderPerksSet(address indexed nft, uint16 holderBurnBps, uint16 holderVaultBps);
    event BurnModeSet(uint8 mode);
    event FeeWalletSet(address indexed feeWallet);
    event ServerAuthoritySet(address indexed serverAuthority);
    event PausedSet(bool paused);
    event ArenaCreated(uint16 indexed arenaId, uint128 entryFee, uint16 maxSessions);
    event ArenaUpdated(uint16 indexed arenaId, uint128 entryFee, uint16 maxSessions, bool enabled);
    event ArenaHoldersOnlySet(uint16 indexed arenaId, bool holdersOnly);
    event Joined(
        uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 entryFee, uint16 burnBps, uint16 vaultBps
    );
    event Settled(
        uint16 indexed arenaId,
        address indexed player,
        uint64 indexed sessionId,
        uint128 payout,
        uint128 net,
        uint128 burned,
        uint128 toVault,
        bool collected
    );
    event FeeBurned(uint128 amount, bool viaBurnCall);
    event FeeToVault(address indexed feeWallet, uint128 amount);
    event Cancelled(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 amount, bool collected);
    event SettleSkipped(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint8 reason);
    event Refunded(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 amount);
    event Collected(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 amount);
    event LootBurned(uint16 indexed arenaId, uint64 indexed sweepId, uint128 amount, bool viaBurnCall);
    event ArenaSwept(uint16 indexed arenaId, address indexed feeWallet, uint128 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20("Elymum", "ELYMUM", 18);
        arena = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        arena.setToken(address(token));
        arena.createArena(ID, FEE, 300);
        vm.stopPrank();
        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address who) internal {
        token.mint(who, 1_000_000 ether);
        vm.prank(who);
        token.approve(address(arena), type(uint256).max);
    }

    function _join(address who) internal returns (uint64) {
        vm.prank(who);
        arena.join(ID);
        return arena.getSession(ID, who).id;
    }

    function _one(uint16 id, address player, uint64 sid, uint128 payout)
        internal
        pure
        returns (ElymumArena.Settlement[] memory items)
    {
        items = new ElymumArena.Settlement[](1);
        items[0] = ElymumArena.Settlement(id, player, sid, payout);
    }

    function _settle(ElymumArena.Settlement[] memory items) internal {
        vm.prank(server);
        arena.settle(items);
    }

    function _ref(uint16 id, address player, uint64 sid) internal pure returns (ElymumArena.SessionRef[] memory items) {
        items = new ElymumArena.SessionRef[](1);
        items[0] = ElymumArena.SessionRef(id, player, sid);
    }

    function _cancel(ElymumArena.SessionRef[] memory items) internal {
        vm.prank(server);
        arena.cancel(items);
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    /// @dev balance == Σ vault + Σ owed for the one arena of a fixture.
    function _assertSolvent(ElymumArena a, address tok) internal view {
        ElymumArena.ArenaView memory v = a.getArena(ID);
        assertEq(MockERC20(tok).balanceOf(address(a)), uint256(v.vault) + v.owed, "balance == vault + owed");
    }

    function _arenaWith(address tok) internal returns (ElymumArena a) {
        a = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        a.setToken(tok);
        a.createArena(ID, FEE, 300);
        vm.stopPrank();
    }

    function _blockingArena() internal returns (ElymumArena a, BlockingToken blk) {
        blk = new BlockingToken();
        a = _arenaWith(address(blk));
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            blk.mint(ps[i], 10 * FEE);
            vm.prank(ps[i]);
            blk.approve(address(a), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------- constructor & config

    function test_constructor_setsConfig() public {
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        ElymumArena.ConfigView memory c = a.config();
        assertEq(c.admin, admin);
        assertEq(c.pendingAdmin, address(0));
        assertEq(c.serverAuthority, server);
        assertEq(c.feeWallet, feeWallet);
        assertEq(c.token, address(0));
        assertEq(c.decimals, 0);
        assertEq(c.burnBps, 1_500);
        assertEq(c.vaultBps, 500);
        assertEq(c.holderBurnBps, 1_500);
        assertEq(c.holderVaultBps, 500);
        assertEq(c.holderNft, address(0));
        assertEq(c.burnMode, 0);
        assertFalse(c.paused);
        assertEq(c.totalSessions, 0);
        assertEq(a.arenaIds().length, 0);
        assertEq(a.version(), 3);
        assertEq(a.MAX_TOTAL_FEE_BPS(), 2_500);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ElymumArena(address(0), server, feeWallet);
        vm.expectRevert(ElymumArena.ZeroAddress.selector);
        new ElymumArena(admin, address(0), feeWallet);
        vm.expectRevert(ElymumArena.ZeroAddress.selector);
        new ElymumArena(admin, server, address(0));
    }

    function test_setToken_once_readsDecimals() public {
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        vm.expectEmit(address(a));
        emit TokenSet(address(six), 6);
        vm.prank(admin);
        a.setToken(address(six));
        assertEq(a.config().decimals, 6);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.TokenAlreadySet.selector);
        a.setToken(address(token));
    }

    function test_setToken_reverts() public {
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        vm.expectRevert(ElymumArena.ZeroAddress.selector);
        a.setToken(address(0));
        vm.expectRevert(ElymumArena.NotAContract.selector);
        a.setToken(alice);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        a.setToken(address(token));
        // createArena needs the token
        vm.prank(admin);
        vm.expectRevert(ElymumArena.TokenNotSet.selector);
        a.createArena(ID, FEE, 10);
    }

    function test_setFeeRates_capsAndEvents() public {
        vm.expectEmit(address(arena));
        emit FeeRatesSet(2_000, 500);
        vm.prank(admin);
        arena.setFeeRates(2_000, 500); // exactly the cap
        assertEq(arena.config().burnBps, 2_000);
        assertEq(arena.config().vaultBps, 500);

        vm.startPrank(admin);
        vm.expectRevert(ElymumArena.InvalidFee.selector);
        arena.setFeeRates(2_001, 500);
        vm.expectRevert(ElymumArena.InvalidFee.selector);
        arena.setFeeRates(0, 2_501);
        vm.expectRevert(ElymumArena.InvalidFee.selector);
        arena.setFeeRates(type(uint16).max, type(uint16).max); // no overflow in the sum
        arena.setFeeRates(0, 0);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setFeeRates(1, 1);
    }

    function test_setBurnMode() public {
        vm.expectEmit(address(arena));
        emit BurnModeSet(1);
        vm.prank(admin);
        arena.setBurnMode(1);
        assertEq(arena.burnMode(), 1);
        assertEq(arena.config().burnMode, 1);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.InvalidBurnMode.selector);
        arena.setBurnMode(2);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setBurnMode(0);
    }

    function test_setFeeWallet_and_serverAuthority() public {
        vm.startPrank(admin);
        vm.expectRevert(ElymumArena.ZeroAddress.selector);
        arena.setFeeWallet(address(0));
        vm.expectRevert(ElymumArena.ZeroAddress.selector);
        arena.setServerAuthority(address(0));
        vm.expectEmit(address(arena));
        emit FeeWalletSet(bob);
        arena.setFeeWallet(bob);
        vm.expectEmit(address(arena));
        emit ServerAuthoritySet(carol);
        arena.setServerAuthority(carol);
        vm.stopPrank();
        assertEq(arena.config().feeWallet, bob);
        assertEq(arena.config().serverAuthority, carol);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setFeeWallet(stranger);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setServerAuthority(stranger);
    }

    function test_pause_blocksJoinsOnly() public {
        uint64 sa = _join(alice);
        uint64 sb = _join(bob);
        _join(carol);
        vm.expectEmit(address(arena));
        emit PausedSet(true);
        vm.prank(admin);
        arena.setPaused(true);
        address p = makeAddr("late");
        _fund(p);
        vm.prank(p);
        vm.expectRevert(ElymumArena.Paused.selector);
        arena.join(ID);
        // settle, cancel, refund and loot burns keep working
        _settle(_one(ID, alice, sa, 1_200 ether));
        _cancel(_ref(ID, bob, sb));
        vm.prank(server);
        arena.sweepLoot(ID, 1, 1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(carol);
        arena.refund(ID);
        vm.prank(admin);
        arena.setPaused(false);
        vm.prank(p);
        arena.join(ID);
    }

    function test_createArena_and_reverts() public {
        vm.expectEmit(address(arena));
        emit ArenaCreated(2, 5 ether, 10);
        vm.prank(admin);
        arena.createArena(2, 5 ether, 10);
        ElymumArena.ArenaView memory v = arena.getArena(2);
        assertTrue(v.exists && v.enabled);
        assertEq(v.entryFee, 5 ether);
        assertEq(arena.arenaIds().length, 2);

        vm.startPrank(admin);
        vm.expectRevert(ElymumArena.InvalidArenaId.selector);
        arena.createArena(0, FEE, 10);
        vm.expectRevert(ElymumArena.ArenaExists.selector);
        arena.createArena(2, FEE, 10);
        vm.expectRevert(ElymumArena.EntryFeeZero.selector);
        arena.createArena(3, 0, 10);
        vm.expectRevert(ElymumArena.InvalidMaxSessions.selector);
        arena.createArena(3, FEE, 1);
        vm.expectRevert(ElymumArena.InvalidMaxSessions.selector);
        arena.createArena(3, FEE, 2_001);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.createArena(3, FEE, 10);
    }

    function test_updateArena() public {
        _join(alice);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.ArenaBusy.selector);
        arena.updateArena(ID, FEE + 1, 300, true);
        vm.expectEmit(address(arena));
        emit ArenaUpdated(ID, FEE, 5, false);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 5, false); // same fee: allowed while busy
        vm.prank(bob);
        vm.expectRevert(ElymumArena.ArenaDisabled.selector);
        arena.join(ID);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.UnknownArena.selector);
        arena.updateArena(9, FEE, 5, true);
    }

    // ---------------------------------------------------------------- join

    function test_join_opensSessionWithTheWholeEntryInTheVault() public {
        vm.expectEmit(address(arena));
        emit Joined(ID, alice, 1, FEE, 1_500, 500);
        vm.prank(alice);
        arena.join(ID);
        ElymumArena.SessionView memory s = arena.getSession(ID, alice);
        assertEq(s.id, 1);
        assertEq(s.entryFee, FEE);
        assertEq(s.burnBps, 1_500);
        assertEq(s.vaultBps, 500);
        assertEq(s.openedAt, block.timestamp);
        assertFalse(s.finalized);
        ElymumArena.ArenaView memory v = arena.getArena(ID);
        assertEq(v.vault, FEE); // no entry fee cut
        assertEq(v.openSessions, 1);
        assertEq(v.totalDeposited, FEE);
        assertEq(arena.config().totalStaked, FEE);
        _assertSolvent(arena, address(token));
    }

    function test_join_reverts() public {
        _join(alice);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.SessionExists.selector);
        arena.join(ID);
        vm.prank(bob);
        vm.expectRevert(ElymumArena.UnknownArena.selector);
        arena.join(9);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 2, true);
        _join(bob);
        vm.prank(carol);
        vm.expectRevert(ElymumArena.ArenaFull.selector);
        arena.join(ID);
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.TokenNotSet.selector);
        a.join(ID);
    }

    function test_join_refusesFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        ElymumArena a = _arenaWith(address(fot));
        fot.mint(alice, 10 * FEE);
        vm.prank(alice);
        fot.approve(address(a), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.FeeOnTransferToken.selector);
        a.join(ID);
    }

    function test_join_ratesFixedAtJoin() public {
        uint64 sa = _join(alice);
        vm.prank(admin);
        arena.setFeeRates(0, 0);
        uint64 sb = _join(bob);
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](2);
        items[0] = ElymumArena.Settlement(ID, alice, sa, 1_500 ether);
        items[1] = ElymumArena.Settlement(ID, bob, sb, 500 ether);
        uint256 a0 = token.balanceOf(alice);
        _settle(items);
        // alice joined at 15 % + 5 %: profit 500 → burn 75, vault 25
        assertEq(token.balanceOf(alice) - a0, 1_400 ether);
        assertEq(token.balanceOf(feeWallet), 25 ether);
        assertEq(token.balanceOf(DEAD), 75 ether);
    }

    // ---------------------------------------------------------------- settle: fee math

    function test_settle_profitPaysTheFee() public {
        uint64 sa = _join(alice);
        _join(bob);
        uint256 a0 = token.balanceOf(alice);
        vm.expectEmit(address(arena));
        emit Settled(ID, alice, sa, 2_000 ether, 1_800 ether, 150 ether, 50 ether, true);
        vm.expectEmit(address(arena));
        emit FeeBurned(150 ether, false);
        vm.expectEmit(address(arena));
        emit FeeToVault(feeWallet, 50 ether);
        _settle(_one(ID, alice, sa, 2_000 ether));
        // profit 1,000: 150 burned, 50 to the fee wallet, 1,800 to alice
        assertEq(token.balanceOf(alice) - a0, 1_800 ether);
        assertEq(token.balanceOf(DEAD), 150 ether);
        assertEq(token.balanceOf(feeWallet), 50 ether);
        ElymumArena.ArenaView memory v = arena.getArena(ID);
        assertEq(v.vault, 0);
        assertEq(v.totalPaidOut, 1_800 ether);
        assertEq(v.totalBurned, 150 ether);
        assertEq(v.totalFees, 50 ether);
        ElymumArena.ConfigView memory c = arena.config();
        assertEq(c.totalFeeBurned, 150 ether);
        assertEq(c.totalFeeToVault, 50 ether);
        assertEq(c.totalPaidOut, 1_800 ether);
        assertEq(c.totalGames, 1);
        _assertSolvent(arena, address(token));
    }

    function test_settle_lossPaysNoFee() public {
        uint64 sa = _join(alice);
        uint256 a0 = token.balanceOf(alice);
        vm.recordLogs();
        _settle(_one(ID, alice, sa, 400 ether));
        assertEq(token.balanceOf(alice) - a0, 400 ether);
        assertEq(token.balanceOf(feeWallet), 0);
        assertEq(token.balanceOf(DEAD), 0);
        assertEq(arena.getArena(ID).vault, 600 ether);
        // no FeeBurned / FeeToVault events for a batch without profit
        bytes32 burnedTopic = keccak256("FeeBurned(uint128,bool)");
        bytes32 vaultTopic = keccak256("FeeToVault(address,uint128)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != burnedTopic && logs[i].topics[0] != vaultTopic);
        }
    }

    function test_settle_breakEvenPaysNoFee() public {
        uint64 sa = _join(alice);
        uint256 a0 = token.balanceOf(alice);
        _settle(_one(ID, alice, sa, FEE));
        assertEq(token.balanceOf(alice) - a0, FEE);
        assertEq(token.balanceOf(feeWallet) + token.balanceOf(DEAD), 0);
    }

    function test_settle_zeroPayoutClosesTicket() public {
        uint64 sa = _join(alice);
        uint256 a0 = token.balanceOf(alice);
        vm.expectEmit(address(arena));
        emit Settled(ID, alice, sa, 0, 0, 0, 0, true);
        _settle(_one(ID, alice, sa, 0));
        assertEq(token.balanceOf(alice), a0);
        assertEq(arena.getSession(ID, alice).id, 0);
        assertEq(arena.getArena(ID).openSessions, 0);
        assertEq(arena.getArena(ID).vault, FEE);
    }

    function test_settle_roundingIsInThePlayersFavour() public {
        uint64 sa = _join(alice);
        _join(bob);
        // profit of 1 wei, 3 wei, 19 wei: every share rounds down
        uint256 a0 = token.balanceOf(alice);
        _settle(_one(ID, alice, sa, FEE + 19));
        // 19 * 1500 / 10000 = 2 (2.85), 19 * 500 / 10000 = 0 (0.95)
        assertEq(token.balanceOf(alice) - a0, FEE + 17);
        assertEq(token.balanceOf(DEAD), 2);
        assertEq(token.balanceOf(feeWallet), 0);
        (uint128 net, uint128 burned, uint128 toVault) = arena.computeFees(FEE, FEE + 1, 1_500, 500);
        assertEq(net, FEE + 1);
        assertEq(burned + toVault, 0);
        (net, burned, toVault) = arena.computeFees(FEE, FEE + 20, 1_500, 500);
        assertEq(burned, 3);
        assertEq(toVault, 1);
        assertEq(net, FEE + 16);
    }

    function test_settle_maxPayoutIsTheWholeVault() public {
        uint64 sa = _join(alice);
        _join(bob);
        _join(carol);
        // alice wins the whole vault (3,000): profit 2,000 → 300 burned, 100 fee, 2,600 net
        uint256 a0 = token.balanceOf(alice);
        _settle(_one(ID, alice, sa, 3 * FEE));
        assertEq(token.balanceOf(alice) - a0, 2_600 ether);
        assertEq(arena.getArena(ID).vault, 0);
        // the others can only be settled at 0 now
        uint64 sb = arena.getSession(ID, bob).id;
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, bob, sb, 4);
        _settle(_one(ID, bob, sb, 1));
        _settle(_one(ID, bob, sb, 0));
        _assertSolvent(arena, address(token));
    }

    function test_settle_atTheCap() public {
        vm.prank(admin);
        arena.setFeeRates(2_000, 500);
        uint64 sa = _join(alice);
        _join(bob);
        uint256 a0 = token.balanceOf(alice);
        _settle(_one(ID, alice, sa, 2 * FEE));
        assertEq(token.balanceOf(alice) - a0, 1_750 ether); // 25 % of the profit 1,000
        assertEq(token.balanceOf(DEAD), 200 ether);
        assertEq(token.balanceOf(feeWallet), 50 ether);
    }

    function test_settle_zeroRatesTakeNothing() public {
        vm.prank(admin);
        arena.setFeeRates(0, 0);
        uint64 sa = _join(alice);
        _join(bob);
        uint256 a0 = token.balanceOf(alice);
        _settle(_one(ID, alice, sa, 2 * FEE));
        assertEq(token.balanceOf(alice) - a0, 2 * FEE);
        assertEq(token.balanceOf(DEAD) + token.balanceOf(feeWallet), 0);
    }

    function test_settle_oneBurnAndOneFeeTransferPerBatch() public {
        address[5] memory ps = [makeAddr("p0"), makeAddr("p1"), makeAddr("p2"), makeAddr("p3"), makeAddr("p4")];
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](5);
        for (uint256 i; i < 5; ++i) {
            _fund(ps[i]);
            items[i] = ElymumArena.Settlement(ID, ps[i], _join(ps[i]), 0);
        }
        items[0].payout = 2_000 ether; // profit 1,000
        items[1].payout = 1_500 ether; // profit 500
        items[2].payout = 1_000 ether; // even
        items[3].payout = 500 ether; //   loss
        // 5th: 0
        vm.expectEmit(address(arena));
        emit FeeBurned(225 ether, false);
        vm.expectEmit(address(arena));
        emit FeeToVault(feeWallet, 75 ether);
        _settle(items);
        assertEq(token.balanceOf(DEAD), 225 ether);
        assertEq(token.balanceOf(feeWallet), 75 ether);
        assertEq(arena.getArena(ID).vault, 0);
        _assertSolvent(arena, address(token));
    }

    function test_settle_onlyServer() public {
        uint64 sa = _join(alice);
        ElymumArena.Settlement[] memory items = _one(ID, alice, sa, FEE);
        vm.prank(stranger);
        vm.expectRevert(ElymumArena.NotServer.selector);
        arena.settle(items);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.NotServer.selector);
        arena.settle(items);
    }

    function test_settle_skipReasons() public {
        uint64 sa = _join(alice);
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](4);
        items[0] = ElymumArena.Settlement(9, alice, sa, 1); // unknown arena
        items[1] = ElymumArena.Settlement(ID, alice, sa + 1, 1); // session mismatch
        items[2] = ElymumArena.Settlement(ID, bob, 0, 1); // no session
        items[3] = ElymumArena.Settlement(ID, alice, sa, FEE + 1); // more than the vault
        vm.expectEmit(address(arena));
        emit SettleSkipped(9, alice, sa, 1);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sa + 1, 2);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, bob, 0, 2);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sa, 4);
        _settle(items);
        assertEq(arena.getSession(ID, alice).id, sa); // still open
        vm.prank(server);
        arena.settle(new ElymumArena.Settlement[](0)); // empty batch is a no-op
    }

    function test_settle_replayIsSkipped() public {
        uint64 sa = _join(alice);
        _join(bob);
        _settle(_one(ID, alice, sa, 1_200 ether));
        _join(alice); // a new ticket with a new id
        uint256 a0 = token.balanceOf(alice);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sa, 2);
        _settle(_one(ID, alice, sa, 1_200 ether));
        assertEq(token.balanceOf(alice), a0);
    }

    function test_settle_failingFeeTransferRevertsBatch() public {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        vm.prank(alice);
        a.join(ID);
        vm.prank(bob);
        a.join(ID);
        blk.setBlocked(feeWallet, true);
        ElymumArena.Settlement[] memory items = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
        vm.prank(server);
        vm.expectRevert("blocked");
        a.settle(items);
        assertFalse(a.getSession(ID, alice).finalized);
        assertEq(a.getArena(ID).openSessions, 2);
        // a loss pays no fee: it goes through while the fee wallet is blocked
        items[0].payout = 500 ether;
        vm.prank(server);
        a.settle(items);
        assertEq(a.getSession(ID, alice).id, 0);
    }

    function test_settle_failingBurnRevertsBatch() public {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        vm.prank(alice);
        a.join(ID);
        vm.prank(bob);
        a.join(ID);
        blk.setBlocked(DEAD, true);
        ElymumArena.Settlement[] memory items = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
        vm.prank(server);
        vm.expectRevert("blocked");
        a.settle(items);
        assertEq(a.getArena(ID).openSessions, 2);
    }

    function test_settle_twoPhase_revertingPlayer() public {
        _twoPhase(1);
    }

    function test_settle_twoPhase_falseReturningPlayer() public {
        _twoPhase(2);
    }

    function _twoPhase(uint8 mode) internal {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        blk.setMode(mode);
        vm.prank(alice);
        a.join(ID);
        vm.prank(bob);
        a.join(ID);
        vm.prank(carol);
        a.join(ID);
        uint64 sa = a.getSession(ID, alice).id;
        uint64 sb = a.getSession(ID, bob).id;
        blk.setBlocked(alice, true);

        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](2);
        items[0] = ElymumArena.Settlement(ID, alice, sa, 2 * FEE); // net 1,800 held as owed
        items[1] = ElymumArena.Settlement(ID, bob, sb, 500 ether); // the batch is not griefed
        uint256 b0 = blk.balanceOf(bob);
        vm.expectEmit(address(a));
        emit Settled(ID, alice, sa, 2 * FEE, 1_800 ether, 150 ether, 50 ether, false);
        vm.prank(server);
        a.settle(items);
        assertEq(blk.balanceOf(bob) - b0, 500 ether);
        assertEq(blk.balanceOf(feeWallet), 50 ether);
        assertEq(blk.balanceOf(DEAD), 150 ether);

        ElymumArena.SessionView memory s = a.getSession(ID, alice);
        assertEq(s.id, sa);
        assertTrue(s.finalized);
        assertEq(s.owed, 1_800 ether);
        assertEq(s.entryFee, FEE);
        assertEq(s.burnBps, 1_500);
        assertEq(s.vaultBps, 500);
        ElymumArena.ArenaView memory v = a.getArena(ID);
        assertEq(v.owed, 1_800 ether);
        assertEq(v.vault, 3 * FEE - 2 * FEE - 500 ether);
        assertEq(v.openSessions, 1); // only carol
        _assertSolvent(a, address(blk));

        // A finalized ticket cannot be settled again, nor cancelled.
        vm.expectEmit(address(a));
        emit SettleSkipped(ID, alice, sa, 3);
        vm.prank(server);
        a.settle(_one(ID, alice, sa, 0));
        vm.expectEmit(address(a));
        emit SettleSkipped(ID, alice, sa, 3);
        vm.prank(server);
        a.cancel(_ref(ID, alice, sa));

        // A finalized player cannot open a second ticket before collecting.
        vm.prank(alice);
        vm.expectRevert(ElymumArena.SessionExists.selector);
        a.join(ID);

        // Collect while still blocked reverts (and keeps the claim).
        vm.prank(alice);
        if (mode == 1) vm.expectRevert("blocked");
        else vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(blk)));
        a.refund(ID);

        blk.setBlocked(alice, false);
        uint256 a0 = blk.balanceOf(alice);
        vm.expectEmit(address(a));
        emit Collected(ID, alice, sa, 1_800 ether);
        vm.prank(alice);
        a.refund(ID);
        assertEq(blk.balanceOf(alice) - a0, 1_800 ether);
        assertEq(a.getArena(ID).owed, 0);
        _assertSolvent(a, address(blk));
    }

    function test_settle_cannotSpendOwedOfAnotherPlayer() public {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        vm.prank(alice);
        a.join(ID);
        vm.prank(bob);
        a.join(ID);
        vm.prank(carol);
        a.join(ID);
        blk.setBlocked(alice, true);
        ElymumArena.Settlement[] memory it1 = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
        vm.prank(server);
        a.settle(it1); // owed 1,800, vault 1,000
        uint128 vault = a.getArena(ID).vault;
        assertEq(vault, FEE);
        uint64 sb = a.getSession(ID, bob).id;
        vm.expectEmit(address(a));
        emit SettleSkipped(ID, bob, sb, 4);
        vm.prank(server);
        a.settle(_one(ID, bob, sb, vault + 1));
        vm.prank(server);
        vm.expectRevert(ElymumArena.InsufficientVault.selector);
        a.sweepLoot(ID, 1, vault + 1);
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        a.refund(ID); // the whole vault, never the owed amount
        vm.prank(carol);
        a.refund(ID); // nothing left
        assertEq(blk.balanceOf(address(a)), 1_800 ether);
        assertEq(a.getArena(ID).owed, 1_800 ether);
    }

    function test_capacityBelowOpenCount() public {
        uint64 sa = _join(alice);
        uint64 sb = _join(bob);
        _join(carol);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 2, true);
        _settle(_one(ID, alice, sa, FEE));
        vm.prank(alice);
        vm.expectRevert(ElymumArena.ArenaFull.selector);
        arena.join(ID);
        _settle(_one(ID, bob, sb, FEE));
        _join(alice);
        assertEq(arena.getArena(ID).openSessions, 2);
    }

    // ---------------------------------------------------------------- burn modes

    function test_burnModeCall_burnsTheSupply() public {
        BurnableMock brn = new BurnableMock();
        ElymumArena a = _arenaWith(address(brn));
        vm.prank(admin);
        a.setBurnMode(1);
        address[2] memory ps = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            brn.mint(ps[i], 10 * FEE);
            vm.prank(ps[i]);
            brn.approve(address(a), type(uint256).max);
            vm.prank(ps[i]);
            a.join(ID);
        }
        uint256 supply = brn.totalSupply();
        ElymumArena.Settlement[] memory it2 = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
        vm.expectEmit(address(a));
        emit FeeBurned(150 ether, true);
        vm.prank(server);
        a.settle(it2);
        assertEq(brn.totalSupply(), supply - 150 ether);
        assertEq(brn.balanceOf(DEAD), 0);
        assertEq(brn.balanceOf(feeWallet), 50 ether);
        // loot burns use the same path
        vm.expectEmit(address(a));
        emit LootBurned(ID, 1, 0, false);
        vm.prank(server);
        a.sweepLoot(ID, 1, 0);
        _assertSolvent(a, address(brn));
    }

    function test_burnModeCall_fallsBackToDeadAddress() public {
        // a token without burn(): the call fails, the tokens go to 0x…dEaD
        vm.prank(admin);
        arena.setBurnMode(1);
        uint64 sa = _join(alice);
        _join(bob);
        vm.expectEmit(address(arena));
        emit FeeBurned(150 ether, false);
        _settle(_one(ID, alice, sa, 2 * FEE));
        assertEq(token.balanceOf(DEAD), 150 ether);

        // a burn() that succeeds but burns nothing, and one that reverts: fallback too
        FakeBurnToken fk = new FakeBurnToken();
        ElymumArena a = _arenaWith(address(fk));
        vm.prank(admin);
        a.setBurnMode(1);
        address[4] memory ps = [alice, bob, carol, makeAddr("dave")];
        for (uint256 i; i < 4; ++i) {
            fk.mint(ps[i], 10 * FEE);
            vm.prank(ps[i]);
            fk.approve(address(a), type(uint256).max);
            vm.prank(ps[i]);
            a.join(ID);
        }
        ElymumArena.Settlement[] memory s1 = _one(ID, alice, a.getSession(ID, alice).id, 1_500 ether);
        vm.prank(server);
        a.settle(s1);
        assertEq(fk.balanceOf(DEAD), 75 ether);
        fk.setMode(2);
        ElymumArena.Settlement[] memory s2 = _one(ID, bob, a.getSession(ID, bob).id, 1_100 ether);
        vm.prank(server);
        a.settle(s2);
        assertEq(fk.balanceOf(DEAD), 90 ether);
        // a burn() that burns a different amount: the batch reverts (never a silent loss)
        fk.setMode(1);
        ElymumArena.Settlement[] memory s3 = _one(ID, carol, a.getSession(ID, carol).id, 1_100 ether);
        vm.prank(server);
        vm.expectRevert(ElymumArena.BurnMismatch.selector);
        a.settle(s3);
        _assertSolvent(a, address(fk));
    }

    function test_burnModeCall_withTestToken() public {
        TestToken tt = new TestToken(admin);
        ElymumArena a = _arenaWith(address(tt));
        vm.prank(admin);
        a.setBurnMode(1);
        vm.startPrank(admin);
        tt.mint(alice, 10 * FEE);
        tt.mint(bob, 10 * FEE);
        vm.stopPrank();
        vm.prank(alice);
        tt.approve(address(a), type(uint256).max);
        vm.prank(bob);
        tt.approve(address(a), type(uint256).max);
        vm.prank(alice);
        a.join(ID);
        vm.prank(bob);
        a.join(ID);
        uint256 supply = tt.totalSupply();
        ElymumArena.Settlement[] memory it5 = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
        vm.prank(server);
        a.settle(it5);
        assertEq(tt.totalSupply(), supply - 150 ether);
    }

    // ---------------------------------------------------------------- pay (power-ups and other off-chain sales)

    event PaymentBurnBpsSet(uint16 paymentBurnBps);
    event Paid(address indexed payer, bytes32 indexed ref, uint128 amount, uint128 burned, uint128 toVault, bool viaBurnCall);

    function test_pay_splitsBurnAndFeeWallet() public {
        _join(bob); // an open vault is never touched by a payment
        bytes32 ref = keccak256("order-1");
        uint256 a0 = token.balanceOf(alice);
        vm.expectEmit(address(arena));
        emit Paid(alice, ref, 601 ether + 1, 300.5 ether, 300.5 ether + 1, false);
        vm.prank(alice);
        arena.pay(601 ether + 1, ref);
        assertEq(a0 - token.balanceOf(alice), 601 ether + 1);
        assertEq(token.balanceOf(DEAD), 300.5 ether); // rounds down: the odd wei goes to the fee wallet
        assertEq(token.balanceOf(feeWallet), 300.5 ether + 1);
        assertEq(token.balanceOf(address(arena)), FEE); // only bob's ticket
        ElymumArena.ConfigView memory c = arena.config();
        assertEq(c.paymentBurnBps, 5_000);
        assertEq(c.totalPayments, 601 ether + 1);
        assertEq(c.totalPaymentBurned, 300.5 ether);
        _assertSolvent(arena, address(token));
    }

    function test_pay_ratesAndReverts() public {
        vm.expectEmit(address(arena));
        emit PaymentBurnBpsSet(10_000);
        vm.prank(admin);
        arena.setPaymentBurnBps(10_000);
        vm.prank(alice);
        arena.pay(100 ether, bytes32(0));
        assertEq(token.balanceOf(DEAD), 100 ether);
        assertEq(token.balanceOf(feeWallet), 0);
        vm.prank(admin);
        arena.setPaymentBurnBps(0);
        vm.prank(alice);
        arena.pay(100 ether, bytes32(0));
        assertEq(token.balanceOf(feeWallet), 100 ether);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.InvalidFee.selector);
        arena.setPaymentBurnBps(10_001);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setPaymentBurnBps(1);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.EntryFeeZero.selector);
        arena.pay(0, bytes32(0));
        // works while paused (it is not a ticket)
        vm.prank(admin);
        arena.setPaused(true);
        vm.prank(alice);
        arena.pay(1 ether, bytes32(0));
        // needs the token
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.TokenNotSet.selector);
        a.pay(1, bytes32(0));
        // refuses fee-on-transfer tokens
        FeeOnTransferToken fot = new FeeOnTransferToken();
        ElymumArena b = _arenaWith(address(fot));
        fot.mint(alice, 10 ether);
        vm.prank(alice);
        fot.approve(address(b), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.FeeOnTransferToken.selector);
        b.pay(1 ether, bytes32(0));
    }

    function test_pay_burnCall() public {
        BurnableMock brn = new BurnableMock();
        ElymumArena a = _arenaWith(address(brn));
        vm.prank(admin);
        a.setBurnMode(1);
        brn.mint(alice, 10 ether);
        vm.prank(alice);
        brn.approve(address(a), type(uint256).max);
        uint256 supply = brn.totalSupply();
        vm.expectEmit(address(a));
        emit Paid(alice, bytes32(uint256(7)), 4 ether, 2 ether, 2 ether, true);
        vm.prank(alice);
        a.pay(4 ether, bytes32(uint256(7)));
        assertEq(brn.totalSupply(), supply - 2 ether);
        assertEq(brn.balanceOf(feeWallet), 2 ether);
        assertEq(brn.balanceOf(address(a)), 0);
    }

    function testFuzz_pay(uint128 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 10_000));
        amount = uint128(bound(amount, 1, 1_000_000 ether));
        vm.prank(admin);
        arena.setPaymentBurnBps(bps);
        uint256 before = token.balanceOf(address(arena));
        vm.prank(alice);
        arena.pay(amount, bytes32(0));
        assertEq(token.balanceOf(address(arena)), before);
        assertEq(token.balanceOf(DEAD) + token.balanceOf(feeWallet), amount);
        assertEq(token.balanceOf(DEAD), (uint256(amount) * bps) / 10_000);
    }

    // ---------------------------------------------------------------- cancel

    function test_cancel_refundsTheFullEntryFee() public {
        uint64 sa = _join(alice);
        uint256 a0 = token.balanceOf(alice);
        vm.expectEmit(address(arena));
        emit Cancelled(ID, alice, sa, FEE, true);
        _cancel(_ref(ID, alice, sa));
        assertEq(token.balanceOf(alice) - a0, FEE);
        assertEq(arena.getArena(ID).vault, 0);
        assertEq(arena.getArena(ID).openSessions, 0);
        assertEq(token.balanceOf(feeWallet) + token.balanceOf(DEAD), 0);
        _join(alice);
    }

    function test_cancel_skipReasonsAndOnlyServer() public {
        uint64 sa = _join(alice);
        vm.prank(stranger);
        vm.expectRevert(ElymumArena.NotServer.selector);
        arena.cancel(_ref(ID, alice, sa));
        vm.expectEmit(address(arena));
        emit SettleSkipped(9, alice, sa, 1);
        _cancel(_ref(9, alice, sa));
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sa + 5, 2);
        _cancel(_ref(ID, alice, sa + 5));
        // the vault cannot cover the entry fee any more (loot burns drained it)
        vm.prank(server);
        arena.sweepLoot(ID, 1, 1);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sa, 4);
        _cancel(_ref(ID, alice, sa));
    }

    function test_cancel_twoPhase() public {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        vm.prank(alice);
        a.join(ID);
        uint64 sa = a.getSession(ID, alice).id;
        blk.setBlocked(alice, true);
        vm.expectEmit(address(a));
        emit Cancelled(ID, alice, sa, FEE, false);
        vm.prank(server);
        a.cancel(_ref(ID, alice, sa));
        assertTrue(a.getSession(ID, alice).finalized);
        assertEq(a.getArena(ID).owed, FEE);
        _assertSolvent(a, address(blk));
        blk.setBlocked(alice, false);
        vm.prank(alice);
        a.refund(ID);
        assertEq(blk.balanceOf(address(a)), 0);
    }

    // ---------------------------------------------------------------- refund

    function test_refund_after24h() public {
        uint64 sid = _join(alice);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.RefundTooEarly.selector);
        arena.refund(ID);
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(alice);
        vm.expectRevert(ElymumArena.RefundTooEarly.selector);
        arena.refund(ID);
        vm.warp(block.timestamp + 1);
        uint256 a0 = token.balanceOf(alice);
        vm.expectEmit(address(arena));
        emit Refunded(ID, alice, sid, FEE);
        vm.prank(alice);
        arena.refund(ID);
        assertEq(token.balanceOf(alice) - a0, FEE);
        assertEq(arena.getArena(ID).openSessions, 0);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sid, 2);
        _settle(_one(ID, alice, sid, FEE));
        vm.prank(alice);
        vm.expectRevert(ElymumArena.NoSession.selector);
        arena.refund(ID);
    }

    function test_refund_cappedByVault() public {
        uint64 sa = _join(alice);
        _join(bob);
        _settle(_one(ID, alice, sa, 1_800 ether)); // vault left: 200
        vm.warp(block.timestamp + 1 days);
        uint256 b0 = token.balanceOf(bob);
        vm.prank(bob);
        arena.refund(ID);
        assertEq(token.balanceOf(bob) - b0, 200 ether);
        assertEq(arena.getArena(ID).vault, 0);
        _assertSolvent(arena, address(token));
    }

    // ---------------------------------------------------------------- loot & sweeps

    function test_sweepLoot_burnsWithMonotonicIds() public {
        _join(alice);
        vm.expectEmit(address(arena));
        emit LootBurned(ID, 5, 100 ether, false);
        vm.prank(server);
        arena.sweepLoot(ID, 5, 100 ether);
        assertEq(token.balanceOf(DEAD), 100 ether);
        assertEq(arena.getArena(ID).lastSweepId, 5);
        assertEq(arena.config().totalLootBurned, 100 ether);
        assertEq(arena.getArena(ID).totalBurned, 100 ether);
        vm.prank(server);
        vm.expectRevert(ElymumArena.SweepIdNotIncreasing.selector);
        arena.sweepLoot(ID, 5, 1);
        vm.prank(server);
        vm.expectRevert(ElymumArena.InsufficientVault.selector);
        arena.sweepLoot(ID, 6, FEE);
        vm.prank(server);
        vm.expectRevert(ElymumArena.UnknownArena.selector);
        arena.sweepLoot(9, 6, 1);
        vm.prank(stranger);
        vm.expectRevert(ElymumArena.NotServer.selector);
        arena.sweepLoot(ID, 6, 1);
    }

    function test_sweepArena_onlyDisabledAndIdle() public {
        uint64 sa = _join(alice);
        _join(bob);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.ArenaEnabled.selector);
        arena.sweepArena(ID);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 300, false);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.ArenaHasOpenSessions.selector);
        arena.sweepArena(ID);
        _settle(_one(ID, alice, sa, 500 ether));
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        arena.refund(ID); // takes 1,000 back, 500 remains
        vm.expectEmit(address(arena));
        emit ArenaSwept(ID, feeWallet, 500 ether);
        vm.prank(admin);
        arena.sweepArena(ID);
        assertEq(token.balanceOf(feeWallet), 500 ether);
        assertEq(token.balanceOf(address(arena)), 0);
        vm.prank(admin);
        arena.sweepArena(ID); // empty: no-op
        vm.prank(admin);
        vm.expectRevert(ElymumArena.UnknownArena.selector);
        arena.sweepArena(7);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.sweepArena(ID);
    }

    function test_sweepArena_keepsOwed() public {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        vm.prank(alice);
        a.join(ID);
        vm.prank(bob);
        a.join(ID);
        blk.setBlocked(alice, true);
        ElymumArena.Settlement[] memory it6 = _one(ID, alice, a.getSession(ID, alice).id, 1_500 ether);
        vm.prank(server);
        a.settle(it6); // owed 1,400
        ElymumArena.Settlement[] memory it7 = _one(ID, bob, a.getSession(ID, bob).id, 0);
        vm.prank(server);
        a.settle(it7);
        vm.prank(admin);
        a.updateArena(ID, FEE, 300, false);
        vm.prank(admin);
        a.sweepArena(ID);
        assertEq(blk.balanceOf(address(a)), 1_400 ether);
        assertEq(a.getArena(ID).owed, 1_400 ether);
    }

    // ---------------------------------------------------------------- rescue & ownership

    function test_rescue() public {
        vm.deal(address(arena), 3 ether);
        vm.expectEmit(address(arena));
        emit Rescued(address(0), bob, 2 ether);
        vm.prank(admin);
        arena.rescue(address(0), bob, 2 ether);
        assertEq(bob.balance, 2 ether);
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(arena), 5 ether);
        vm.prank(admin);
        arena.rescue(address(other), bob, 5 ether);
        assertEq(other.balanceOf(bob), 5 ether);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.CannotRescueGameToken.selector);
        arena.rescue(address(token), admin, 1);
        RejectEther rej = new RejectEther();
        vm.startPrank(admin);
        vm.expectRevert(ElymumArena.ZeroAddress.selector);
        arena.rescue(address(0), address(0), 1);
        vm.expectRevert(ElymumArena.NativeTransferFailed.selector);
        arena.rescue(address(0), address(rej), 1);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.rescue(address(0), stranger, 1);
    }

    function test_ownable2Step_and_noRenounce() public {
        vm.prank(admin);
        arena.transferOwnership(bob);
        assertEq(arena.config().pendingAdmin, bob);
        vm.prank(carol);
        vm.expectRevert(_unauthorized(carol));
        arena.acceptOwnership();
        vm.prank(bob);
        arena.acceptOwnership();
        assertEq(arena.owner(), bob);
        vm.prank(bob);
        vm.expectRevert(ElymumArena.RenounceDisabled.selector);
        arena.renounceOwnership();
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrancy_tokenCallbackIsBlocked() public {
        ReentrantToken re = new ReentrantToken();
        ElymumArena a = _arenaWith(address(re));
        re.mint(alice, 10 * FEE);
        vm.prank(alice);
        re.approve(address(a), type(uint256).max);
        vm.prank(alice);
        a.join(ID);
        re.mint(address(re), 10 * FEE);
        vm.prank(address(re));
        re.approve(address(a), type(uint256).max);
        // the token re-enters `join` / `settle` / `refund` during the payout transfer
        bytes[3] memory calls = [
            abi.encodeCall(ElymumArena.join, (ID)),
            abi.encodeCall(ElymumArena.settle, (_one(ID, alice, 1, 0))),
            abi.encodeCall(ElymumArena.refund, (ID))
        ];
        re.arm(address(a), calls[0]);
        vm.prank(server);
        a.settle(_one(ID, alice, 1, FEE));
        assertFalse(re.lastCallOk());
        assertEq(bytes4(re.lastRevert()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(a.getSession(ID, address(re)).id, 0);
        for (uint256 i = 1; i < 3; ++i) {
            vm.prank(alice);
            a.join(ID);
            re.arm(address(a), calls[i]);
            ElymumArena.Settlement[] memory it8 = _one(ID, alice, a.getSession(ID, alice).id, FEE);
            vm.prank(server);
            a.settle(it8);
            assertFalse(re.lastCallOk());
            // a re-entered `settle` is refused by the server check first; `refund` by the guard
            bytes4 want = i == 1 ? ElymumArena.NotServer.selector : ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
            assertEq(bytes4(re.lastRevert()), want);
        }
    }

    // ---------------------------------------------------------------- holder perks

    function test_holderPerks_lowerRates() public {
        MockNFT nft = new MockNFT();
        nft.setBalance(alice, 1);
        vm.expectEmit(address(arena));
        emit HolderPerksSet(address(nft), 1_000, 0);
        vm.prank(admin);
        arena.setHolderPerks(address(nft), 1_000, 0);
        (uint16 b, uint16 v) = arena.feeRatesFor(alice);
        assertEq(b, 1_000);
        assertEq(v, 0);
        (b, v) = arena.feeRatesFor(bob);
        assertEq(b, 1_500);
        assertEq(v, 500);
        uint64 sa = _join(alice);
        _join(bob);
        assertEq(arena.getSession(ID, alice).burnBps, 1_000);
        assertEq(arena.getSession(ID, alice).vaultBps, 0);
        uint256 a0 = token.balanceOf(alice);
        _settle(_one(ID, alice, sa, 2 * FEE));
        assertEq(token.balanceOf(alice) - a0, 1_900 ether);
        assertEq(token.balanceOf(feeWallet), 0);
    }

    function test_holderPerks_neverHigherThanNormal() public {
        MockNFT nft = new MockNFT();
        nft.setBalance(alice, 1);
        vm.prank(admin);
        arena.setHolderPerks(address(nft), 2_000, 500);
        _join(alice);
        assertEq(arena.getSession(ID, alice).burnBps, 1_500);
        assertEq(arena.getSession(ID, alice).vaultBps, 500);
    }

    function test_setHolderPerks_reverts() public {
        vm.startPrank(admin);
        vm.expectRevert(ElymumArena.InvalidFee.selector);
        arena.setHolderPerks(address(0), 2_000, 501);
        vm.expectRevert(ElymumArena.NotAContract.selector);
        arena.setHolderPerks(alice, 0, 0);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setHolderPerks(address(0), 0, 0);
    }

    function test_join_brokenNftNeverBlocks() public {
        BrokenNFT nft = new BrokenNFT();
        vm.prank(admin);
        arena.setHolderPerks(address(nft), 0, 0);
        for (uint8 m = 1; m <= 6; ++m) {
            nft.setMode(m);
            address p = address(uint160(0xB000 + m));
            assertFalse(arena.isHolder(p));
            _fund(p);
            vm.prank(p);
            arena.join(ID);
            assertEq(arena.getSession(ID, p).burnBps, 1_500);
        }
    }

    function test_holdersOnly() public {
        MockNFT nft = new MockNFT();
        nft.setBalance(alice, 1);
        vm.prank(admin);
        arena.setHolderPerks(address(nft), 1_500, 500);
        vm.expectEmit(address(arena));
        emit ArenaHoldersOnlySet(ID, true);
        vm.prank(admin);
        arena.setArenaHoldersOnly(ID, true);
        vm.prank(bob);
        vm.expectRevert(ElymumArena.HoldersOnly.selector);
        arena.join(ID);
        _join(alice);
        vm.prank(admin);
        arena.setHolderPerks(address(0), 0, 0);
        vm.prank(carol);
        vm.expectRevert(ElymumArena.HoldersOnly.selector);
        arena.join(ID);
        vm.prank(admin);
        arena.setArenaHoldersOnly(ID, false);
        _join(carol);
        vm.prank(admin);
        vm.expectRevert(ElymumArena.UnknownArena.selector);
        arena.setArenaHoldersOnly(77, true);
    }

    // ---------------------------------------------------------------- security

    /// @dev A stolen server key can pay one ticket the whole vault of an arena, never payouts held as `owed`; the owner
    ///      stops it by rotating the authority.
    function test_security_compromisedServerKey_blastRadiusIsTheOpenVault() public {
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        address attacker = makeAddr("attacker");
        blk.mint(attacker, 10 * FEE);
        vm.prank(attacker);
        blk.approve(address(a), type(uint256).max);
        vm.prank(bob);
        a.join(ID);
        blk.setBlocked(bob, true);
        ElymumArena.Settlement[] memory it9 = _one(ID, bob, a.getSession(ID, bob).id, FEE);
        vm.prank(server);
        a.settle(it9);
        blk.setBlocked(bob, false);
        vm.prank(alice);
        a.join(ID);
        vm.prank(attacker);
        a.join(ID);
        assertEq(a.getArena(ID).vault, 2 * FEE);
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](2);
        items[0] = ElymumArena.Settlement(ID, alice, a.getSession(ID, alice).id, 0);
        items[1] = ElymumArena.Settlement(ID, attacker, a.getSession(ID, attacker).id, 2 * FEE);
        uint256 before = blk.balanceOf(attacker);
        vm.prank(server);
        a.settle(items);
        // even the thief pays the fee on the "profit"
        assertEq(blk.balanceOf(attacker) - before, 1_800 ether);
        assertEq(a.getArena(ID).owed, FEE);
        vm.prank(bob);
        a.refund(ID);
        vm.prank(admin);
        a.setServerAuthority(makeAddr("newServer"));
        vm.prank(server);
        vm.expectRevert(ElymumArena.NotServer.selector);
        a.sweepLoot(ID, 1, 0);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_computeFees(uint128 entryFee, uint128 payout, uint16 burnBps, uint16 vaultBps) public view {
        burnBps = uint16(bound(burnBps, 0, 2_500));
        vaultBps = uint16(bound(vaultBps, 0, 2_500 - burnBps));
        (uint128 net, uint128 burned, uint128 toVault) = arena.computeFees(entryFee, payout, burnBps, vaultBps);
        assertEq(uint256(net) + burned + toVault, payout, "shares add up to the payout");
        if (payout <= entryFee) {
            assertEq(burned + toVault, 0, "no fee without profit");
        } else {
            uint256 profit = uint256(payout) - entryFee;
            assertLe(uint256(burned) + toVault, (profit * 2_500) / 10_000, "never above the cap");
            assertEq(burned, (profit * burnBps) / 10_000);
            assertEq(toVault, (profit * vaultBps) / 10_000);
            assertGe(net, entryFee, "a winner never gets less than the stake back");
        }
    }

    /// @dev Random batches: every token is accounted for (players + dEaD + fee wallet + contract == supply).
    function testFuzz_settleConservation(uint128[6] memory payouts, uint8 blockMask, uint16 burnBps, uint16 vaultBps)
        public
    {
        burnBps = uint16(bound(burnBps, 0, 2_500));
        vaultBps = uint16(bound(vaultBps, 0, 2_500 - burnBps));
        (ElymumArena a, BlockingToken blk) = _blockingArena();
        vm.prank(admin);
        a.setFeeRates(burnBps, vaultBps);
        address[6] memory ps;
        for (uint256 i; i < 6; ++i) {
            ps[i] = address(uint160(0xA000 + i));
            blk.mint(ps[i], FEE);
            vm.prank(ps[i]);
            blk.approve(address(a), type(uint256).max);
            vm.prank(ps[i]);
            a.join(ID);
        }
        uint256 supply = blk.totalSupply();
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](6);
        for (uint256 i; i < 6; ++i) {
            items[i] = ElymumArena.Settlement(ID, ps[i], a.getSession(ID, ps[i]).id, uint128(bound(payouts[i], 0, 6 * FEE)));
            if ((blockMask >> i) & 1 == 1) blk.setBlocked(ps[i], true);
        }
        vm.prank(server);
        a.settle(items);
        _assertSolvent(a, address(blk));
        uint256 held;
        for (uint256 i; i < 6; ++i) held += blk.balanceOf(ps[i]);
        held += blk.balanceOf(DEAD) + blk.balanceOf(feeWallet) + blk.balanceOf(address(a));
        held += blk.balanceOf(alice) + blk.balanceOf(bob) + blk.balanceOf(carol);
        assertEq(held, supply);
        ElymumArena.ArenaView memory v = a.getArena(ID);
        assertEq(uint256(v.totalDeposited), uint256(v.vault) + v.totalPaidOut + v.totalBurned + v.totalFees);
    }

    function testFuzz_refundNeverExceedsVault(uint128 first) public {
        uint64 sa = _join(alice);
        _join(bob);
        first = uint128(bound(first, 0, 2 * FEE));
        _settle(_one(ID, alice, sa, first));
        vm.warp(block.timestamp + 1 days);
        uint128 vault = arena.getArena(ID).vault;
        uint256 b0 = token.balanceOf(bob);
        vm.prank(bob);
        arena.refund(ID);
        uint256 got = token.balanceOf(bob) - b0;
        assertLe(got, FEE);
        assertLe(got, vault);
        _assertSolvent(arena, address(token));
    }

    // ---------------------------------------------------------------- gas

    function test_gas_join_settle1_settle40() public {
        _join(alice);
        address p = makeAddr("gas-player");
        _fund(p);
        vm.prank(p);
        uint256 g = gasleft();
        arena.join(ID);
        emit log_named_uint("gas join", g - gasleft());
        ElymumArena.Settlement[] memory first = _one(ID, p, arena.getSession(ID, p).id, 1_500 ether);
        vm.prank(server);
        g = gasleft();
        arena.settle(first);
        emit log_named_uint("gas settle(1, with profit)", g - gasleft());

        vm.prank(admin);
        arena.updateArena(ID, FEE, 2_000, true);
        ElymumArena.Settlement[] memory many = new ElymumArena.Settlement[](40);
        for (uint256 i; i < 40; ++i) {
            address q = address(uint160(0x5000 + i));
            _fund(q);
            vm.prank(q);
            arena.join(ID);
            many[i] = ElymumArena.Settlement(ID, q, arena.getSession(ID, q).id, uint128(500 ether + i * 30 ether));
        }
        vm.prank(server);
        g = gasleft();
        arena.settle(many);
        uint256 used = g - gasleft();
        emit log_named_uint("gas settle(40)", used);
        assertLt(used, 3_000_000);
    }
}

