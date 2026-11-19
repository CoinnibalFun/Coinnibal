// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoinnibalArena} from "../contracts/CoinnibalArena.sol";
import {JoinPermits} from "./JoinPermits.sol";
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

/// @notice Unit and fuzz tests of CoinnibalArena v3 (fee on profit: 15 % burned, 5 % to the fee wallet by default).
contract CoinnibalArenaTest is Test {
    /// @dev The game server's join permit (signed with the "server" test key) for `player` in `arenaId`, now.
    function _permit(CoinnibalArena a, address player, uint16 arenaId) internal view returns (JoinPermits.Permit memory) {
        return JoinPermits.permit(a, JoinPermits.keyOf("server"), player, arenaId);
    }

    CoinnibalArena internal arena;
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
        token = new MockERC20("Coinnibal", "COINNIBAL", 18);
        arena = new CoinnibalArena(admin, server, feeWallet);
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
        JoinPermits.Permit memory pm1 = _permit(arena, who, ID);
        vm.prank(who);
        arena.join(ID, pm1.deadline, pm1.sig);
        return arena.getSession(ID, who).id;
    }

    function _one(uint16 id, address player, uint64 sid, uint128 payout)
        internal
        pure
        returns (CoinnibalArena.Settlement[] memory items)
    {
        items = new CoinnibalArena.Settlement[](1);
        items[0] = CoinnibalArena.Settlement(id, player, sid, payout);
    }

    function _settle(CoinnibalArena.Settlement[] memory items) internal {
        vm.prank(server);
        arena.settle(items);
    }

    function _ref(uint16 id, address player, uint64 sid) internal pure returns (CoinnibalArena.SessionRef[] memory items) {
        items = new CoinnibalArena.SessionRef[](1);
        items[0] = CoinnibalArena.SessionRef(id, player, sid);
    }

    function _cancel(CoinnibalArena.SessionRef[] memory items) internal {
        vm.prank(server);
        arena.cancel(items);
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    /// @dev balance == Σ vault + Σ owed for the one arena of a fixture.
    function _assertSolvent(CoinnibalArena a, address tok) internal view {
        CoinnibalArena.ArenaView memory v = a.getArena(ID);
        assertEq(MockERC20(tok).balanceOf(address(a)), uint256(v.vault) + v.owed, "balance == vault + owed");
    }

    function _arenaWith(address tok) internal returns (CoinnibalArena a) {
        a = new CoinnibalArena(admin, server, feeWallet);
        vm.startPrank(admin);
        a.setToken(tok);
        a.createArena(ID, FEE, 300);
        vm.stopPrank();
    }

    function _blockingArena() internal returns (CoinnibalArena a, BlockingToken blk) {
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
        CoinnibalArena a = new CoinnibalArena(admin, server, feeWallet);
        CoinnibalArena.ConfigView memory c = a.config();
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
        assertEq(a.version(), 4);
        assertEq(a.MAX_TOTAL_FEE_BPS(), 2_500);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new CoinnibalArena(address(0), server, feeWallet);
        vm.expectRevert(CoinnibalArena.ZeroAddress.selector);
        new CoinnibalArena(admin, address(0), feeWallet);
        vm.expectRevert(CoinnibalArena.ZeroAddress.selector);
        new CoinnibalArena(admin, server, address(0));
    }

    function test_setToken_once_readsDecimals() public {
        CoinnibalArena a = new CoinnibalArena(admin, server, feeWallet);
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        vm.expectEmit(address(a));
        emit TokenSet(address(six), 6);
        vm.prank(admin);
        a.setToken(address(six));
        assertEq(a.config().decimals, 6);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.TokenAlreadySet.selector);
        a.setToken(address(token));
    }

    function test_setToken_reverts() public {
        CoinnibalArena a = new CoinnibalArena(admin, server, feeWallet);
        vm.startPrank(admin);
        vm.expectRevert(CoinnibalArena.ZeroAddress.selector);
        a.setToken(address(0));
        vm.expectRevert(CoinnibalArena.NotAContract.selector);
        a.setToken(alice);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        a.setToken(address(token));
        // createArena needs the token
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.TokenNotSet.selector);
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
        vm.expectRevert(CoinnibalArena.InvalidFee.selector);
        arena.setFeeRates(2_001, 500);
        vm.expectRevert(CoinnibalArena.InvalidFee.selector);
        arena.setFeeRates(0, 2_501);
        vm.expectRevert(CoinnibalArena.InvalidFee.selector);
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
        vm.expectRevert(CoinnibalArena.InvalidBurnMode.selector);
        arena.setBurnMode(2);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setBurnMode(0);
    }

    function test_setFeeWallet_and_serverAuthority() public {
        vm.startPrank(admin);
        vm.expectRevert(CoinnibalArena.ZeroAddress.selector);
        arena.setFeeWallet(address(0));
        vm.expectRevert(CoinnibalArena.ZeroAddress.selector);
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
        JoinPermits.Permit memory pm2 = _permit(arena, p, ID);
        vm.prank(p);
        vm.expectRevert(CoinnibalArena.Paused.selector);
        arena.join(ID, pm2.deadline, pm2.sig);
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
        JoinPermits.Permit memory pm3 = _permit(arena, p, ID);
        vm.prank(p);
        arena.join(ID, pm3.deadline, pm3.sig);
    }

    function test_createArena_and_reverts() public {
        vm.expectEmit(address(arena));
        emit ArenaCreated(2, 5 ether, 10);
        vm.prank(admin);
        arena.createArena(2, 5 ether, 10);
        CoinnibalArena.ArenaView memory v = arena.getArena(2);
        assertTrue(v.exists && v.enabled);
        assertEq(v.entryFee, 5 ether);
        assertEq(arena.arenaIds().length, 2);

        vm.startPrank(admin);
        vm.expectRevert(CoinnibalArena.InvalidArenaId.selector);
        arena.createArena(0, FEE, 10);
        vm.expectRevert(CoinnibalArena.ArenaExists.selector);
        arena.createArena(2, FEE, 10);
        vm.expectRevert(CoinnibalArena.EntryFeeZero.selector);
        arena.createArena(3, 0, 10);
        vm.expectRevert(CoinnibalArena.InvalidMaxSessions.selector);
        arena.createArena(3, FEE, 1);
        vm.expectRevert(CoinnibalArena.InvalidMaxSessions.selector);
        arena.createArena(3, FEE, 2_001);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.createArena(3, FEE, 10);
    }

    function test_updateArena() public {
        _join(alice);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.ArenaBusy.selector);
        arena.updateArena(ID, FEE + 1, 300, true);
        vm.expectEmit(address(arena));
        emit ArenaUpdated(ID, FEE, 5, false);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 5, false); // same fee: allowed while busy
        JoinPermits.Permit memory pm4 = _permit(arena, bob, ID);
        vm.prank(bob);
        vm.expectRevert(CoinnibalArena.ArenaDisabled.selector);
        arena.join(ID, pm4.deadline, pm4.sig);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.UnknownArena.selector);
        arena.updateArena(9, FEE, 5, true);
    }

    // ---------------------------------------------------------------- join

    function test_join_opensSessionWithTheWholeEntryInTheVault() public {
        JoinPermits.Permit memory pm5 = _permit(arena, alice, ID);
        vm.expectEmit(address(arena));
        emit Joined(ID, alice, 1, FEE, 1_500, 500);
        vm.prank(alice);
        arena.join(ID, pm5.deadline, pm5.sig);
        CoinnibalArena.SessionView memory s = arena.getSession(ID, alice);
        assertEq(s.id, 1);
        assertEq(s.entryFee, FEE);
        assertEq(s.burnBps, 1_500);
        assertEq(s.vaultBps, 500);
        assertEq(s.openedAt, block.timestamp);
        assertFalse(s.finalized);
        CoinnibalArena.ArenaView memory v = arena.getArena(ID);
        assertEq(v.vault, FEE); // no entry fee cut
        assertEq(v.openSessions, 1);
        assertEq(v.totalDeposited, FEE);
        assertEq(arena.config().totalStaked, FEE);
        _assertSolvent(arena, address(token));
    }

    // ---------------------------------------------------------------- join permits (v4)

    uint256 internal constant SERVER_KEY = uint256(keccak256(abi.encodePacked("server")));

    function _sig(uint256 key, address player, uint16 id, uint64 nonce, uint64 deadline) internal view returns (bytes memory) {
        return JoinPermits.sign(key, address(arena), block.chainid, player, id, nonce, deadline);
    }

    function _joinWith(address who, uint16 id, uint64 deadline, bytes memory sig) internal {
        vm.prank(who);
        arena.join(id, deadline, sig);
    }

    function _expectJoinRevert(address who, uint16 id, uint64 deadline, bytes memory sig, bytes4 err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        arena.join(id, deadline, sig);
    }

    function test_permit_validJoinUsesTheNonce() public {
        assertEq(server, vm.addr(SERVER_KEY), "the test server key");
        assertEq(arena.joinNonce(alice), 0);
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        _joinWith(alice, ID, dl, _sig(SERVER_KEY, alice, ID, 0, dl));
        assertEq(arena.getSession(ID, alice).id, 1);
        assertEq(arena.joinNonce(alice), 1, "the permit is used up");
        assertEq(arena.joinNonce(bob), 0, "per player");
        // the edges of the window: a permit that expires this very second, and one exactly MAX_PERMIT_WINDOW ahead
        _joinWith(bob, ID, uint64(block.timestamp), _sig(SERVER_KEY, bob, ID, 0, uint64(block.timestamp)));
        uint64 far = uint64(block.timestamp) + arena.MAX_PERMIT_WINDOW();
        _joinWith(carol, ID, far, _sig(SERVER_KEY, carol, ID, 0, far));
        assertEq(arena.getArena(ID).openSessions, 3);
    }

    function test_permit_expired() public {
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        bytes memory sig = _sig(SERVER_KEY, alice, ID, 0, dl);
        vm.warp(uint256(dl) + 1);
        _expectJoinRevert(alice, ID, dl, sig, CoinnibalArena.PermitExpired.selector);
        assertEq(arena.joinNonce(alice), 0);
    }

    function test_permit_tooFarAhead_noStockpiling() public {
        uint64 far = uint64(block.timestamp) + arena.MAX_PERMIT_WINDOW() + 1;
        _expectJoinRevert(alice, ID, far, _sig(SERVER_KEY, alice, ID, 0, far), CoinnibalArena.PermitTooFarAhead.selector);
        uint64 huge = type(uint64).max;
        _expectJoinRevert(alice, ID, huge, _sig(SERVER_KEY, alice, ID, 0, huge), CoinnibalArena.PermitTooFarAhead.selector);
        // a permit for a later nonce cannot be kept for later either: it names a nonce the player has not reached
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        _expectJoinRevert(alice, ID, dl, _sig(SERVER_KEY, alice, ID, 1, dl), CoinnibalArena.InvalidPermit.selector);
    }

    function test_permit_wrongSigner() public {
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        _expectJoinRevert(alice, ID, dl, _sig(uint256(keccak256("stranger")), alice, ID, 0, dl), CoinnibalArena.InvalidPermit.selector);
        // the player cannot sign their own permit, nor can the owner
        _expectJoinRevert(alice, ID, dl, _sig(JoinPermits.keyOf("alice"), alice, ID, 0, dl), CoinnibalArena.InvalidPermit.selector);
        _expectJoinRevert(alice, ID, dl, _sig(JoinPermits.keyOf("admin"), alice, ID, 0, dl), CoinnibalArena.InvalidPermit.selector);
    }

    function test_permit_wrongPlayerArenaChainOrContract() public {
        vm.prank(admin);
        arena.createArena(2, FEE, 300);
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        // alice's permit is alice's: bob cannot use it
        _expectJoinRevert(bob, ID, dl, _sig(SERVER_KEY, alice, ID, 0, dl), CoinnibalArena.InvalidPermit.selector);
        // a permit for arena 1 does not open arena 2
        _expectJoinRevert(alice, 2, dl, _sig(SERVER_KEY, alice, ID, 0, dl), CoinnibalArena.InvalidPermit.selector);
        // the other deadline than the one signed
        _expectJoinRevert(alice, ID, dl + 1, _sig(SERVER_KEY, alice, ID, 0, dl), CoinnibalArena.InvalidPermit.selector);
        // signed for another chain, or another arena contract
        bytes memory otherChain = JoinPermits.sign(SERVER_KEY, address(arena), block.chainid + 1, alice, ID, 0, dl);
        _expectJoinRevert(alice, ID, dl, otherChain, CoinnibalArena.InvalidPermit.selector);
        CoinnibalArena twin = _arenaWith(address(token));
        bytes memory forTwin = JoinPermits.sign(SERVER_KEY, address(twin), block.chainid, alice, ID, 0, dl);
        _expectJoinRevert(alice, ID, dl, forTwin, CoinnibalArena.InvalidPermit.selector);
        // ...where it does work, once
        vm.prank(alice);
        token.approve(address(twin), type(uint256).max);
        vm.prank(alice);
        twin.join(ID, dl, forTwin);
        assertEq(twin.getSession(ID, alice).id, 1);
        // the same permit on a chain id the contract now reads differently: refused (the domain is read per call)
        uint64 dl2 = uint64(block.timestamp) + 10 minutes;
        bytes memory here = _sig(SERVER_KEY, alice, ID, 0, dl2);
        vm.chainId(block.chainid + 7);
        _expectJoinRevert(alice, ID, dl2, here, CoinnibalArena.InvalidPermit.selector);
    }

    function test_permit_replay() public {
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        bytes memory sig = _sig(SERVER_KEY, alice, ID, 0, dl);
        _joinWith(alice, ID, dl, sig);
        // the ticket is cancelled (never played): the same permit cannot buy another one
        _cancel(_ref(ID, alice, arena.getSession(ID, alice).id));
        _expectJoinRevert(alice, ID, dl, sig, CoinnibalArena.InvalidPermit.selector);
        // a permit issued for the same nonce in another arena is spent too (one counter per player)
        vm.prank(admin);
        arena.createArena(2, FEE, 300);
        _expectJoinRevert(alice, 2, dl, _sig(SERVER_KEY, alice, 2, 0, dl), CoinnibalArena.InvalidPermit.selector);
        _joinWith(alice, 2, dl, _sig(SERVER_KEY, alice, 2, 1, dl));
        assertEq(arena.joinNonce(alice), 2);
    }

    function test_permit_rotatedServerAuthorityInvalidatesOldPermits() public {
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        bytes memory old = _sig(SERVER_KEY, alice, ID, 0, dl);
        (address next, uint256 nextKey) = makeAddrAndKey("server-2");
        vm.prank(admin);
        arena.setServerAuthority(next);
        _expectJoinRevert(alice, ID, dl, old, CoinnibalArena.InvalidPermit.selector);
        _joinWith(alice, ID, dl, _sig(nextKey, alice, ID, 0, dl));
        assertEq(arena.getSession(ID, alice).id, 1);
    }

    function test_permit_malformedSignatures() public {
        uint64 dl = uint64(block.timestamp) + 10 minutes;
        bytes memory good = _sig(SERVER_KEY, alice, ID, 0, dl);
        _expectJoinRevert(alice, ID, dl, "", CoinnibalArena.InvalidPermit.selector);
        _expectJoinRevert(alice, ID, dl, new bytes(65), CoinnibalArena.InvalidPermit.selector);
        bytes memory short = new bytes(64);
        for (uint256 i; i < 64; ++i) short[i] = good[i];
        _expectJoinRevert(alice, ID, dl, short, CoinnibalArena.InvalidPermit.selector);
        // the malleable twin (s' = n - s, v flipped) of a valid signature is refused (OpenZeppelin ECDSA)
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(SERVER_KEY, JoinPermits.digest(address(arena), block.chainid, alice, ID, 0, dl));
        bytes32 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(uint256(n) - uint256(sv)), v == 27 ? uint8(28) : uint8(27));
        _expectJoinRevert(alice, ID, dl, twin, CoinnibalArena.InvalidPermit.selector);
        _joinWith(alice, ID, dl, good);
    }

    function test_permit_domain() public view {
        assertEq(arena.DOMAIN_SEPARATOR(), JoinPermits.domain(address(arena), block.chainid));
        assertEq(arena.JOIN_PERMIT_TYPEHASH(), JoinPermits.PERMIT_TYPEHASH);
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying, bytes32 salt, uint256[] memory ext) =
            arena.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "CoinnibalArena");
        assertEq(version, "4");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(arena));
        assertEq(salt, bytes32(0));
        assertEq(ext.length, 0);
        assertEq(arena.version(), 4);
    }

    function testFuzz_permit_anyDeadlineInTheWindowJoinsOnce(uint64 ahead) public {
        ahead = uint64(bound(ahead, 0, arena.MAX_PERMIT_WINDOW()));
        uint64 dl = uint64(block.timestamp) + ahead;
        bytes memory sig = _sig(SERVER_KEY, alice, ID, 0, dl);
        _joinWith(alice, ID, dl, sig);
        _cancel(_ref(ID, alice, arena.getSession(ID, alice).id));
        _expectJoinRevert(alice, ID, dl, sig, CoinnibalArena.InvalidPermit.selector);
    }

    function test_join_reverts() public {
        _join(alice);
        JoinPermits.Permit memory pm6 = _permit(arena, alice, ID);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.SessionExists.selector);
        arena.join(ID, pm6.deadline, pm6.sig);
        JoinPermits.Permit memory pm7 = _permit(arena, bob, 9);
        vm.prank(bob);
        vm.expectRevert(CoinnibalArena.UnknownArena.selector);
        arena.join(9, pm7.deadline, pm7.sig);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 2, true);
        _join(bob);
        JoinPermits.Permit memory pm8 = _permit(arena, carol, ID);
        vm.prank(carol);
        vm.expectRevert(CoinnibalArena.ArenaFull.selector);
        arena.join(ID, pm8.deadline, pm8.sig);
        CoinnibalArena a = new CoinnibalArena(admin, server, feeWallet);
        JoinPermits.Permit memory pm9 = _permit(a, alice, ID);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.TokenNotSet.selector);
        a.join(ID, pm9.deadline, pm9.sig);
    }

    function test_join_refusesFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        CoinnibalArena a = _arenaWith(address(fot));
        fot.mint(alice, 10 * FEE);
        vm.prank(alice);
        fot.approve(address(a), type(uint256).max);
        JoinPermits.Permit memory pm10 = _permit(a, alice, ID);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.FeeOnTransferToken.selector);
        a.join(ID, pm10.deadline, pm10.sig);
    }

    function test_join_ratesFixedAtJoin() public {
        uint64 sa = _join(alice);
        vm.prank(admin);
        arena.setFeeRates(0, 0);
        uint64 sb = _join(bob);
        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](2);
        items[0] = CoinnibalArena.Settlement(ID, alice, sa, 1_500 ether);
        items[1] = CoinnibalArena.Settlement(ID, bob, sb, 500 ether);
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
        CoinnibalArena.ArenaView memory v = arena.getArena(ID);
        assertEq(v.vault, 0);
        assertEq(v.totalPaidOut, 1_800 ether);
        assertEq(v.totalBurned, 150 ether);
        assertEq(v.totalFees, 50 ether);
        CoinnibalArena.ConfigView memory c = arena.config();
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
        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](5);
        for (uint256 i; i < 5; ++i) {
            _fund(ps[i]);
            items[i] = CoinnibalArena.Settlement(ID, ps[i], _join(ps[i]), 0);
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
        CoinnibalArena.Settlement[] memory items = _one(ID, alice, sa, FEE);
        vm.prank(stranger);
        vm.expectRevert(CoinnibalArena.NotServer.selector);
        arena.settle(items);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.NotServer.selector);
        arena.settle(items);
    }

    function test_settle_skipReasons() public {
        uint64 sa = _join(alice);
        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](4);
        items[0] = CoinnibalArena.Settlement(9, alice, sa, 1); // unknown arena
        items[1] = CoinnibalArena.Settlement(ID, alice, sa + 1, 1); // session mismatch
        items[2] = CoinnibalArena.Settlement(ID, bob, 0, 1); // no session
        items[3] = CoinnibalArena.Settlement(ID, alice, sa, FEE + 1); // more than the vault
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
        arena.settle(new CoinnibalArena.Settlement[](0)); // empty batch is a no-op
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
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        JoinPermits.Permit memory pm11 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm11.deadline, pm11.sig);
        JoinPermits.Permit memory pm12 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm12.deadline, pm12.sig);
        blk.setBlocked(feeWallet, true);
        CoinnibalArena.Settlement[] memory items = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
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
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        JoinPermits.Permit memory pm13 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm13.deadline, pm13.sig);
        JoinPermits.Permit memory pm14 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm14.deadline, pm14.sig);
        blk.setBlocked(DEAD, true);
        CoinnibalArena.Settlement[] memory items = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
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
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        blk.setMode(mode);
        JoinPermits.Permit memory pm15 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm15.deadline, pm15.sig);
        JoinPermits.Permit memory pm16 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm16.deadline, pm16.sig);
        JoinPermits.Permit memory pm17 = _permit(a, carol, ID);
        vm.prank(carol);
        a.join(ID, pm17.deadline, pm17.sig);
        uint64 sa = a.getSession(ID, alice).id;
        uint64 sb = a.getSession(ID, bob).id;
        blk.setBlocked(alice, true);

        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](2);
        items[0] = CoinnibalArena.Settlement(ID, alice, sa, 2 * FEE); // net 1,800 held as owed
        items[1] = CoinnibalArena.Settlement(ID, bob, sb, 500 ether); // the batch is not griefed
        uint256 b0 = blk.balanceOf(bob);
        vm.expectEmit(address(a));
        emit Settled(ID, alice, sa, 2 * FEE, 1_800 ether, 150 ether, 50 ether, false);
        vm.prank(server);
        a.settle(items);
        assertEq(blk.balanceOf(bob) - b0, 500 ether);
        assertEq(blk.balanceOf(feeWallet), 50 ether);
        assertEq(blk.balanceOf(DEAD), 150 ether);

        CoinnibalArena.SessionView memory s = a.getSession(ID, alice);
        assertEq(s.id, sa);
        assertTrue(s.finalized);
        assertEq(s.owed, 1_800 ether);
        assertEq(s.entryFee, FEE);
        assertEq(s.burnBps, 1_500);
        assertEq(s.vaultBps, 500);
        CoinnibalArena.ArenaView memory v = a.getArena(ID);
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
        JoinPermits.Permit memory pm18 = _permit(a, alice, ID);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.SessionExists.selector);
        a.join(ID, pm18.deadline, pm18.sig);

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
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        JoinPermits.Permit memory pm19 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm19.deadline, pm19.sig);
        JoinPermits.Permit memory pm20 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm20.deadline, pm20.sig);
        JoinPermits.Permit memory pm21 = _permit(a, carol, ID);
        vm.prank(carol);
        a.join(ID, pm21.deadline, pm21.sig);
        blk.setBlocked(alice, true);
        CoinnibalArena.Settlement[] memory it1 = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
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
        vm.expectRevert(CoinnibalArena.InsufficientVault.selector);
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
        JoinPermits.Permit memory pm22 = _permit(arena, alice, ID);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.ArenaFull.selector);
        arena.join(ID, pm22.deadline, pm22.sig);
        _settle(_one(ID, bob, sb, FEE));
        _join(alice);
        assertEq(arena.getArena(ID).openSessions, 2);
    }

    // ---------------------------------------------------------------- burn modes

    function test_burnModeCall_burnsTheSupply() public {
        BurnableMock brn = new BurnableMock();
        CoinnibalArena a = _arenaWith(address(brn));
        vm.prank(admin);
        a.setBurnMode(1);
        address[2] memory ps = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            brn.mint(ps[i], 10 * FEE);
            vm.prank(ps[i]);
            brn.approve(address(a), type(uint256).max);
            JoinPermits.Permit memory pm23 = _permit(a, ps[i], ID);
            vm.prank(ps[i]);
            a.join(ID, pm23.deadline, pm23.sig);
        }
        uint256 supply = brn.totalSupply();
        CoinnibalArena.Settlement[] memory it2 = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
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
        CoinnibalArena a = _arenaWith(address(fk));
        vm.prank(admin);
        a.setBurnMode(1);
        address[4] memory ps = [alice, bob, carol, makeAddr("dave")];
        for (uint256 i; i < 4; ++i) {
            fk.mint(ps[i], 10 * FEE);
            vm.prank(ps[i]);
            fk.approve(address(a), type(uint256).max);
            JoinPermits.Permit memory pm24 = _permit(a, ps[i], ID);
            vm.prank(ps[i]);
            a.join(ID, pm24.deadline, pm24.sig);
        }
        CoinnibalArena.Settlement[] memory s1 = _one(ID, alice, a.getSession(ID, alice).id, 1_500 ether);
        vm.prank(server);
        a.settle(s1);
        assertEq(fk.balanceOf(DEAD), 75 ether);
        fk.setMode(2);
        CoinnibalArena.Settlement[] memory s2 = _one(ID, bob, a.getSession(ID, bob).id, 1_100 ether);
        vm.prank(server);
        a.settle(s2);
        assertEq(fk.balanceOf(DEAD), 90 ether);
        // a burn() that burns a different amount: the batch reverts (never a silent loss)
        fk.setMode(1);
        CoinnibalArena.Settlement[] memory s3 = _one(ID, carol, a.getSession(ID, carol).id, 1_100 ether);
        vm.prank(server);
        vm.expectRevert(CoinnibalArena.BurnMismatch.selector);
        a.settle(s3);
        _assertSolvent(a, address(fk));
    }

    function test_burnModeCall_withTestToken() public {
        TestToken tt = new TestToken(admin);
        CoinnibalArena a = _arenaWith(address(tt));
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
        JoinPermits.Permit memory pm25 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm25.deadline, pm25.sig);
        JoinPermits.Permit memory pm26 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm26.deadline, pm26.sig);
        uint256 supply = tt.totalSupply();
        CoinnibalArena.Settlement[] memory it5 = _one(ID, alice, a.getSession(ID, alice).id, 2 * FEE);
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
        CoinnibalArena.ConfigView memory c = arena.config();
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
        vm.expectRevert(CoinnibalArena.InvalidFee.selector);
        arena.setPaymentBurnBps(10_001);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.setPaymentBurnBps(1);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.EntryFeeZero.selector);
        arena.pay(0, bytes32(0));
        // works while paused (it is not a ticket)
        vm.prank(admin);
        arena.setPaused(true);
        vm.prank(alice);
        arena.pay(1 ether, bytes32(0));
        // needs the token
        CoinnibalArena a = new CoinnibalArena(admin, server, feeWallet);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.TokenNotSet.selector);
        a.pay(1, bytes32(0));
        // refuses fee-on-transfer tokens
        FeeOnTransferToken fot = new FeeOnTransferToken();
        CoinnibalArena b = _arenaWith(address(fot));
        fot.mint(alice, 10 ether);
        vm.prank(alice);
        fot.approve(address(b), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.FeeOnTransferToken.selector);
        b.pay(1 ether, bytes32(0));
    }

    function test_pay_burnCall() public {
        BurnableMock brn = new BurnableMock();
        CoinnibalArena a = _arenaWith(address(brn));
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
        vm.expectRevert(CoinnibalArena.NotServer.selector);
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
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        JoinPermits.Permit memory pm27 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm27.deadline, pm27.sig);
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
        vm.expectRevert(CoinnibalArena.RefundTooEarly.selector);
        arena.refund(ID);
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.RefundTooEarly.selector);
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
        vm.expectRevert(CoinnibalArena.NoSession.selector);
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
        vm.expectRevert(CoinnibalArena.SweepIdNotIncreasing.selector);
        arena.sweepLoot(ID, 5, 1);
        vm.prank(server);
        vm.expectRevert(CoinnibalArena.InsufficientVault.selector);
        arena.sweepLoot(ID, 6, FEE);
        vm.prank(server);
        vm.expectRevert(CoinnibalArena.UnknownArena.selector);
        arena.sweepLoot(9, 6, 1);
        vm.prank(stranger);
        vm.expectRevert(CoinnibalArena.NotServer.selector);
        arena.sweepLoot(ID, 6, 1);
    }

    function test_sweepArena_onlyDisabledAndIdle() public {
        uint64 sa = _join(alice);
        _join(bob);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.ArenaEnabled.selector);
        arena.sweepArena(ID);
        vm.prank(admin);
        arena.updateArena(ID, FEE, 300, false);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.ArenaHasOpenSessions.selector);
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
        vm.expectRevert(CoinnibalArena.UnknownArena.selector);
        arena.sweepArena(7);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        arena.sweepArena(ID);
    }

    function test_sweepArena_keepsOwed() public {
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        JoinPermits.Permit memory pm28 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm28.deadline, pm28.sig);
        JoinPermits.Permit memory pm29 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm29.deadline, pm29.sig);
        blk.setBlocked(alice, true);
        CoinnibalArena.Settlement[] memory it6 = _one(ID, alice, a.getSession(ID, alice).id, 1_500 ether);
        vm.prank(server);
        a.settle(it6); // owed 1,400
        CoinnibalArena.Settlement[] memory it7 = _one(ID, bob, a.getSession(ID, bob).id, 0);
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
        vm.expectRevert(CoinnibalArena.CannotRescueGameToken.selector);
        arena.rescue(address(token), admin, 1);
        RejectEther rej = new RejectEther();
        vm.startPrank(admin);
        vm.expectRevert(CoinnibalArena.ZeroAddress.selector);
        arena.rescue(address(0), address(0), 1);
        vm.expectRevert(CoinnibalArena.NativeTransferFailed.selector);
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
        vm.expectRevert(CoinnibalArena.RenounceDisabled.selector);
        arena.renounceOwnership();
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrancy_tokenCallbackIsBlocked() public {
        ReentrantToken re = new ReentrantToken();
        CoinnibalArena a = _arenaWith(address(re));
        re.mint(alice, 10 * FEE);
        vm.prank(alice);
        re.approve(address(a), type(uint256).max);
        JoinPermits.Permit memory pm30 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm30.deadline, pm30.sig);
        re.mint(address(re), 10 * FEE);
        vm.prank(address(re));
        re.approve(address(a), type(uint256).max);
        // the token re-enters `join` (with a valid permit of its own) / `settle` / `refund` during the payout transfer
        JoinPermits.Permit memory rp = _permit(a, address(re), ID);
        bytes[3] memory calls = [
            abi.encodeCall(CoinnibalArena.join, (ID, rp.deadline, rp.sig)),
            abi.encodeCall(CoinnibalArena.settle, (_one(ID, alice, 1, 0))),
            abi.encodeCall(CoinnibalArena.refund, (ID))
        ];
        re.arm(address(a), calls[0]);
        vm.prank(server);
        a.settle(_one(ID, alice, 1, FEE));
        assertFalse(re.lastCallOk());
        assertEq(bytes4(re.lastRevert()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(a.getSession(ID, address(re)).id, 0);
        for (uint256 i = 1; i < 3; ++i) {
            JoinPermits.Permit memory pm31 = _permit(a, alice, ID);
            vm.prank(alice);
            a.join(ID, pm31.deadline, pm31.sig);
            re.arm(address(a), calls[i]);
            CoinnibalArena.Settlement[] memory it8 = _one(ID, alice, a.getSession(ID, alice).id, FEE);
            vm.prank(server);
            a.settle(it8);
            assertFalse(re.lastCallOk());
            // a re-entered `settle` is refused by the server check first; `refund` by the guard
            bytes4 want = i == 1 ? CoinnibalArena.NotServer.selector : ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
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

    /// @dev The USD tiers (2026-11): holders pay 8 % + 2 % of their profit, others 15 % + 5 %; the owner re-prices an
    ///      arena in token units only once no ticket is open, and every ticket settles at the entry fee it recorded.
    function test_usdTiers_holderPairAndReprice() public {
        MockNFT nft = new MockNFT();
        nft.setBalance(alice, 1);
        vm.prank(admin);
        arena.setHolderPerks(address(nft), 800, 200);
        uint64 sa = _join(alice);
        uint64 sb = _join(bob);
        assertEq(arena.getSession(ID, alice).burnBps, 800);
        assertEq(arena.getSession(ID, alice).vaultBps, 200);
        assertEq(arena.getSession(ID, bob).burnBps, 1_500);
        assertEq(arena.getSession(ID, bob).vaultBps, 500);

        // a new price while tickets are open is refused: their entry fee cannot move under them
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.ArenaBusy.selector);
        arena.updateArena(ID, 1_200 ether, 300, true);

        // alice (holder) doubles up: profit 1,000 → 80 burned + 20 to the fee wallet; bob loses half: no fee
        uint256 a0 = token.balanceOf(alice);
        uint256 b0 = token.balanceOf(bob);
        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](2);
        items[0] = CoinnibalArena.Settlement(ID, alice, sa, 1_500 ether);
        items[1] = CoinnibalArena.Settlement(ID, bob, sb, 500 ether);
        _settle(items);
        assertEq(token.balanceOf(alice) - a0, 1_450 ether);
        assertEq(token.balanceOf(bob) - b0, 500 ether);
        assertEq(token.balanceOf(feeWallet), 10 ether);
        assertEq(token.balanceOf(DEAD), 40 ether);

        // no ticket open: the owner's sync re-prices the arena; new tickets pay the new entry fee
        vm.prank(admin);
        arena.updateArena(ID, 1_200 ether, 300, true);
        uint64 sc = _join(carol);
        uint64 sb2 = _join(bob);
        assertEq(arena.getSession(ID, carol).entryFee, 1_200 ether);
        uint256 c0 = token.balanceOf(carol);
        items[0] = CoinnibalArena.Settlement(ID, carol, sc, 2_000 ether);
        items[1] = CoinnibalArena.Settlement(ID, bob, sb2, 400 ether);
        _settle(items);
        // profit against carol's own 1,200 entry: 800 → 120 burned + 40 to the fee wallet
        assertEq(token.balanceOf(carol) - c0, 1_840 ether);
        assertEq(token.balanceOf(feeWallet), 50 ether);
        assertEq(arena.getArena(ID).vault, 0);
        _assertSolvent(arena, address(token));

        // the cap holds for the holder pair too
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.InvalidFee.selector);
        arena.setHolderPerks(address(nft), 2_000, 501);
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
        vm.expectRevert(CoinnibalArena.InvalidFee.selector);
        arena.setHolderPerks(address(0), 2_000, 501);
        vm.expectRevert(CoinnibalArena.NotAContract.selector);
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
            JoinPermits.Permit memory pm32 = _permit(arena, p, ID);
            vm.prank(p);
            arena.join(ID, pm32.deadline, pm32.sig);
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
        JoinPermits.Permit memory pm33 = _permit(arena, bob, ID);
        vm.prank(bob);
        vm.expectRevert(CoinnibalArena.HoldersOnly.selector);
        arena.join(ID, pm33.deadline, pm33.sig);
        _join(alice);
        vm.prank(admin);
        arena.setHolderPerks(address(0), 0, 0);
        JoinPermits.Permit memory pm34 = _permit(arena, carol, ID);
        vm.prank(carol);
        vm.expectRevert(CoinnibalArena.HoldersOnly.selector);
        arena.join(ID, pm34.deadline, pm34.sig);
        vm.prank(admin);
        arena.setArenaHoldersOnly(ID, false);
        _join(carol);
        vm.prank(admin);
        vm.expectRevert(CoinnibalArena.UnknownArena.selector);
        arena.setArenaHoldersOnly(77, true);
    }

    // ---------------------------------------------------------------- security

    /// @dev A stolen server key can pay one ticket the whole vault of an arena, never payouts held as `owed`; the owner
    ///      stops it by rotating the authority.
    function test_security_compromisedServerKey_blastRadiusIsTheOpenVault() public {
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        address attacker = makeAddr("attacker");
        blk.mint(attacker, 10 * FEE);
        vm.prank(attacker);
        blk.approve(address(a), type(uint256).max);
        JoinPermits.Permit memory pm35 = _permit(a, bob, ID);
        vm.prank(bob);
        a.join(ID, pm35.deadline, pm35.sig);
        blk.setBlocked(bob, true);
        CoinnibalArena.Settlement[] memory it9 = _one(ID, bob, a.getSession(ID, bob).id, FEE);
        vm.prank(server);
        a.settle(it9);
        blk.setBlocked(bob, false);
        JoinPermits.Permit memory pm36 = _permit(a, alice, ID);
        vm.prank(alice);
        a.join(ID, pm36.deadline, pm36.sig);
        JoinPermits.Permit memory pm37 = _permit(a, attacker, ID);
        vm.prank(attacker);
        a.join(ID, pm37.deadline, pm37.sig);
        assertEq(a.getArena(ID).vault, 2 * FEE);
        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](2);
        items[0] = CoinnibalArena.Settlement(ID, alice, a.getSession(ID, alice).id, 0);
        items[1] = CoinnibalArena.Settlement(ID, attacker, a.getSession(ID, attacker).id, 2 * FEE);
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
        vm.expectRevert(CoinnibalArena.NotServer.selector);
        a.sweepLoot(ID, 1, 0);
    }

    /// @dev Griefing by capacity: wallets that buy tickets and never play fill `maxSessions` and lock real players
    ///      out (`ArenaFull`) until the server cancels them. Each such ticket ties up a whole entry fee and comes back
    ///      in full, so the attack costs capital and gas, nothing more: the server's stale sweeper (15 min) and a
    ///      high `maxSessions` (the server caps seats per instance anyway) are the defence.
    function test_security_capacityGriefing_cancelFreesTheSeats() public {
        vm.prank(admin);
        arena.updateArena(ID, FEE, 2, true);
        address g1 = makeAddr("griefer1");
        address g2 = makeAddr("griefer2");
        _fund(g1);
        _fund(g2);
        uint64 s1 = _join(g1);
        uint64 s2 = _join(g2);
        JoinPermits.Permit memory pm38 = _permit(arena, alice, ID);
        vm.prank(alice);
        vm.expectRevert(CoinnibalArena.ArenaFull.selector);
        arena.join(ID, pm38.deadline, pm38.sig);
        CoinnibalArena.SessionRef[] memory refs = new CoinnibalArena.SessionRef[](2);
        refs[0] = CoinnibalArena.SessionRef(ID, g1, s1);
        refs[1] = CoinnibalArena.SessionRef(ID, g2, s2);
        _cancel(refs);
        // the griefers got exactly their stakes back, the seats are free again
        assertEq(token.balanceOf(g1), token.balanceOf(g2));
        _join(alice);
        assertEq(arena.getArena(ID).openSessions, 1);
        _assertSolvent(arena, address(token));
    }

    /// @dev A misused server key can push `lastSweepId` to the top of uint64: loot burns of that arena stop for good
    ///      (no value moves; floor loot then stays in the vault as surplus). The server refuses to work past a
    ///      lastSweepId beyond 2^53 and says so loudly; the owner's remedy is a new arena id.
    function test_security_sweepIdCanBeExhaustedOnlyByTheServerKey() public {
        _join(alice);
        vm.prank(stranger);
        vm.expectRevert(CoinnibalArena.NotServer.selector);
        arena.sweepLoot(ID, type(uint64).max, 0);
        vm.prank(server);
        arena.sweepLoot(ID, type(uint64).max, 0);
        vm.prank(server);
        vm.expectRevert(CoinnibalArena.SweepIdNotIncreasing.selector);
        arena.sweepLoot(ID, type(uint64).max, 0);
        // nothing left the vault
        assertEq(arena.getArena(ID).vault, FEE);
        _assertSolvent(arena, address(token));
    }

    /// @dev A held or delayed settlement races the player's own refund after 24 h: whichever lands first wins and the
    ///      other is skipped (session mismatch); the vault never pays twice.
    function test_security_refundAfter24hBeatsALateSettlement_noDoublePay() public {
        uint64 sa = _join(alice);
        _join(bob);
        vm.warp(block.timestamp + 24 hours + 1);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        arena.refund(ID);
        assertEq(token.balanceOf(alice) - before, FEE);
        vm.expectEmit(address(arena));
        emit SettleSkipped(ID, alice, sa, 2);
        _settle(_one(ID, alice, sa, 2 * FEE));
        assertEq(token.balanceOf(alice) - before, FEE);
        assertEq(arena.getArena(ID).vault, FEE);
        _assertSolvent(arena, address(token));
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
        (CoinnibalArena a, BlockingToken blk) = _blockingArena();
        vm.prank(admin);
        a.setFeeRates(burnBps, vaultBps);
        address[6] memory ps;
        for (uint256 i; i < 6; ++i) {
            ps[i] = address(uint160(0xA000 + i));
            blk.mint(ps[i], FEE);
            vm.prank(ps[i]);
            blk.approve(address(a), type(uint256).max);
            JoinPermits.Permit memory pm39 = _permit(a, ps[i], ID);
            vm.prank(ps[i]);
            a.join(ID, pm39.deadline, pm39.sig);
        }
        uint256 supply = blk.totalSupply();
        CoinnibalArena.Settlement[] memory items = new CoinnibalArena.Settlement[](6);
        for (uint256 i; i < 6; ++i) {
            items[i] = CoinnibalArena.Settlement(ID, ps[i], a.getSession(ID, ps[i]).id, uint128(bound(payouts[i], 0, 6 * FEE)));
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
        CoinnibalArena.ArenaView memory v = a.getArena(ID);
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
        JoinPermits.Permit memory pm40 = _permit(arena, p, ID);
        vm.prank(p);
        uint256 g = gasleft();
        arena.join(ID, pm40.deadline, pm40.sig);
        emit log_named_uint("gas join", g - gasleft());
        CoinnibalArena.Settlement[] memory first = _one(ID, p, arena.getSession(ID, p).id, 1_500 ether);
        vm.prank(server);
        g = gasleft();
        arena.settle(first);
        emit log_named_uint("gas settle(1, with profit)", g - gasleft());

        vm.prank(admin);
        arena.updateArena(ID, FEE, 2_000, true);
        CoinnibalArena.Settlement[] memory many = new CoinnibalArena.Settlement[](40);
        for (uint256 i; i < 40; ++i) {
            address q = address(uint160(0x5000 + i));
            _fund(q);
            JoinPermits.Permit memory pm41 = _permit(arena, q, ID);
            vm.prank(q);
            arena.join(ID, pm41.deadline, pm41.sig);
            many[i] = CoinnibalArena.Settlement(ID, q, arena.getSession(ID, q).id, uint128(500 ether + i * 30 ether));
        }
        vm.prank(server);
        g = gasleft();
        arena.settle(many);
        uint256 used = g - gasleft();
        emit log_named_uint("gas settle(40)", used);
        assertLt(used, 3_000_000);
    }
}

