// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ElymumArena} from "../contracts/ElymumArena.sol";
import {ElymumNFT} from "../contracts/ElymumNFT.sol";
import {MockERC20, BlockingToken, FakeBurnToken} from "../contracts/test/MockTokens.sol";

/// @notice Test-only: a smart-contract wallet that borrows an emblem, joins an arena and gives the emblem back,
///         all in one transaction (a "flash" holder). Smart wallets can sign in to the game server (ERC-1271).
contract FlashHolderWallet {
    function borrowJoinReturn(ElymumNFT nft, uint256 tokenId, address lender, ElymumArena arena, uint16 arenaId, MockERC20 token)
        external
    {
        nft.transferFrom(lender, address(this), tokenId);
        token.approve(address(arena), type(uint256).max);
        arena.join(arenaId);
        nft.transferFrom(address(this), lender, tokenId);
    }
}

/// @notice Repros of the mainnet-readiness audit (2026-11). Every test PASSES on the current code: each one
///         demonstrates a behaviour the audit report ranks as a finding, so a fix should make the matching
///         assertion fail (then flip the test).
contract AuditFindingsTest is Test {
    ElymumArena internal arena;
    ElymumNFT internal nft;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal server = makeAddr("server");
    address internal feeWallet = makeAddr("feeWallet");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");

    uint16 internal constant OPEN = 1; // the $1 arena
    uint16 internal constant ISLES = 4; // the $10 holders-only arena
    uint128 internal constant FEE = 1_000 ether;
    uint128 internal constant FEE10 = 10_000 ether;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20("Elymum", "ELYMUM", 18);
        arena = new ElymumArena(admin, server, feeWallet);
        nft = new ElymumNFT(admin, 1_000, 0.0003 ether, 1, 1, "https://elymum.io/api/nft/", admin);
        vm.startPrank(admin);
        arena.setToken(address(token));
        arena.createArena(OPEN, FEE, 300);
        arena.createArena(ISLES, FEE10, 300);
        arena.setHolderPerks(address(nft), 800, 200);
        arena.setArenaHoldersOnly(ISLES, true);
        nft.ownerMint(alice, 1); // token id 1: the only emblem in this fixture
        vm.stopPrank();
        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(mallory);
    }

    function _fund(address who) internal {
        token.mint(who, 1_000_000 ether);
        vm.prank(who);
        token.approve(address(arena), type(uint256).max);
    }

    function _one(uint16 id, address player, uint64 sid, uint128 payout)
        internal
        pure
        returns (ElymumArena.Settlement[] memory items)
    {
        items = new ElymumArena.Settlement[](1);
        items[0] = ElymumArena.Settlement(id, player, sid, payout);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Holder checks are a point-in-time balanceOf at join
    // ------------------------------------------------------------------------------------------------------------

    /// @dev One emblem, passed from wallet to wallet in the same block, gives every wallet the holder fee pair AND
    ///      a seat in the holders-only $10 arena. The rates are fixed into each ticket for good.
    function testAudit_oneEmblemPassedAroundUnlocksManyWallets() public {
        address[3] memory ring = [alice, bob, carol];
        for (uint256 i; i < ring.length; ++i) {
            vm.prank(ring[i]);
            arena.join(ISLES);
            ElymumArena.SessionView memory s = arena.getSession(ISLES, ring[i]);
            assertEq(s.burnBps, 800, "holder burn rate fixed in the ticket");
            assertEq(s.vaultBps, 200, "holder vault rate fixed in the ticket");
            if (i + 1 < ring.length) {
                vm.prank(ring[i]);
                nft.transferFrom(ring[i], ring[i + 1], 1);
            }
        }
        assertEq(arena.getArena(ISLES).openSessions, 3, "three holders-only tickets from one emblem");
        assertEq(nft.balanceOf(alice) + nft.balanceOf(bob), 0, "only carol holds the emblem now");
    }

    /// @dev Atomic variant: a contract wallet borrows the emblem, joins the holders-only arena and returns it in one
    ///      transaction. It never holds the emblem at the end of any block.
    function testAudit_flashBorrowedEmblemJoinsHoldersOnlyArena() public {
        FlashHolderWallet w = new FlashHolderWallet();
        token.mint(address(w), 100_000 ether);
        vm.prank(alice);
        nft.setApprovalForAll(address(w), true); // a lending desk / rental contract would do the same
        w.borrowJoinReturn(nft, 1, alice, arena, ISLES, token);

        assertEq(nft.ownerOf(1), alice, "the emblem is back with its owner");
        assertEq(nft.balanceOf(address(w)), 0, "the wallet holds no emblem");
        ElymumArena.SessionView memory s = arena.getSession(ISLES, address(w));
        assertTrue(s.id != 0, "yet it holds a holders-only ticket");
        assertEq(uint256(s.burnBps) + s.vaultBps, 1_000, "at the holder fee (10 %)");
    }

    // ------------------------------------------------------------------------------------------------------------
    // What a stolen server key can take
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Worst case of a stolen server key: buy one ticket with an own wallet and settle it with the whole vault.
    ///      Every other open ticket is then skipped (vault too small) and their 24 h refund pays min(entry, 0) = 0.
    function testAudit_stolenServerKeyDrainsOpenStakes() public {
        vm.prank(alice);
        arena.join(OPEN);
        vm.prank(bob);
        arena.join(OPEN);
        vm.prank(carol);
        arena.join(OPEN);
        vm.prank(mallory);
        arena.join(OPEN);
        uint64 sid = arena.getSession(OPEN, mallory).id;
        uint128 vault = arena.getArena(OPEN).vault;
        assertEq(vault, 4 * FEE);

        uint256 before = token.balanceOf(mallory);
        vm.prank(server); // the stolen key
        arena.settle(_one(OPEN, mallory, sid, vault));
        // profit 3,000: 20 % fee (600) -> mallory nets 3,400, i.e. 2,400 of the other players' money
        assertEq(token.balanceOf(mallory) - before, 3_400 ether, "attacker nets the vault less the fee on profit");
        assertEq(arena.getArena(OPEN).vault, 0, "the vault is empty");

        // the honest players cannot get anything back: a settlement is skipped and the 24 h refund pays 0
        vm.warp(block.timestamp + 24 hours + 1);
        uint256 b = token.balanceOf(alice);
        vm.prank(alice);
        arena.refund(OPEN);
        assertEq(token.balanceOf(alice), b, "alice's 24 h refund pays nothing");
    }

    /// @dev The owner key is strictly stronger: it can install any server key, then do the above.
    function testAudit_ownerCanInstallAnyServerKey() public {
        vm.prank(admin);
        arena.setServerAuthority(mallory);
        vm.prank(alice);
        arena.join(OPEN);
        vm.prank(mallory);
        arena.join(OPEN);
        uint64 sid = arena.getSession(OPEN, mallory).id;
        vm.prank(mallory);
        arena.settle(_one(OPEN, mallory, sid, 2 * FEE));
        assertEq(arena.getArena(OPEN).vault, 0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Griefing
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Filling an arena's session slots is free: an unplayed ticket is cancelled with the full entry fee back,
    ///      so a griefer only pays gas, and can re-buy at once. One open ticket also blocks any re-pricing.
    function testAudit_slotFillingIsFreeAndOneTicketBlocksRepricing() public {
        vm.prank(admin);
        arena.updateArena(OPEN, FEE, 2, true); // the minimum slot count, to keep the repro short
        vm.prank(mallory);
        arena.join(OPEN);
        vm.prank(bob);
        arena.join(OPEN);
        vm.prank(carol);
        vm.expectRevert(ElymumArena.ArenaFull.selector);
        arena.join(OPEN);

        // the owner cannot re-price the arena while any ticket is open
        vm.prank(admin);
        vm.expectRevert(ElymumArena.ArenaBusy.selector);
        arena.updateArena(OPEN, 1_200 ether, 2, true);

        // the stale sweeper cancels the griefer's ticket: the griefer loses nothing
        uint256 before = token.balanceOf(mallory);
        ElymumArena.SessionRef[] memory refs = new ElymumArena.SessionRef[](1);
        refs[0] = ElymumArena.SessionRef(OPEN, mallory, arena.getSession(OPEN, mallory).id);
        vm.prank(server);
        arena.cancel(refs);
        assertEq(token.balanceOf(mallory) - before, FEE, "full entry fee back, no fee");
    }

    /// @dev The fee wallet's share is sent with a reverting transfer: a token that refuses the fee wallet (a
    ///      blocklist) reverts the whole settle batch, so no winner of the batch is paid until the owner moves the
    ///      fee wallet.
    function testAudit_feeWalletTransferFailureRevertsWholeBatch() public {
        BlockingToken blk = new BlockingToken();
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        a.setToken(address(blk));
        a.createArena(OPEN, FEE, 300);
        vm.stopPrank();
        blk.mint(alice, 10_000 ether);
        blk.mint(bob, 10_000 ether);
        vm.prank(alice);
        blk.approve(address(a), type(uint256).max);
        vm.prank(bob);
        blk.approve(address(a), type(uint256).max);
        vm.prank(alice);
        a.join(OPEN);
        vm.prank(bob);
        a.join(OPEN);
        blk.setBlocked(feeWallet, true);

        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](2);
        items[0] = ElymumArena.Settlement(OPEN, alice, a.getSession(OPEN, alice).id, 2 * FEE); // alice won
        items[1] = ElymumArena.Settlement(OPEN, bob, a.getSession(OPEN, bob).id, 0); // bob lost
        vm.prank(server);
        vm.expectRevert(bytes("blocked"));
        a.settle(items);
    }

    /// @dev Burn mode 1 with a token whose burn() burns a different amount reverts the whole batch (BurnMismatch):
    ///      the burn() path must be probed against the real $ELYMUM before it is turned on.
    function testAudit_partialBurnRevertsWholeBatchInBurnCallMode() public {
        FakeBurnToken fk = new FakeBurnToken();
        ElymumArena a = new ElymumArena(admin, server, feeWallet);
        vm.startPrank(admin);
        a.setToken(address(fk));
        a.createArena(OPEN, FEE, 300);
        a.setBurnMode(1);
        vm.stopPrank();
        fk.mint(alice, 10_000 ether);
        fk.mint(bob, 10_000 ether);
        vm.prank(alice);
        fk.approve(address(a), type(uint256).max);
        vm.prank(bob);
        fk.approve(address(a), type(uint256).max);
        vm.prank(alice);
        a.join(OPEN);
        vm.prank(bob);
        a.join(OPEN);
        fk.setMode(1); // burns half

        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](2);
        items[0] = ElymumArena.Settlement(OPEN, alice, a.getSession(OPEN, alice).id, 2 * FEE);
        items[1] = ElymumArena.Settlement(OPEN, bob, a.getSession(OPEN, bob).id, 0);
        vm.prank(server);
        vm.expectRevert(ElymumArena.BurnMismatch.selector);
        a.settle(items);

        // mode 0 (0x...dEaD) settles the same batch
        vm.prank(admin);
        a.setBurnMode(0);
        vm.prank(server);
        a.settle(items);
        assertEq(fk.balanceOf(0x000000000000000000000000000000000000dEaD), 150 ether, "15 % of the profit to dEaD");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Approval scope
    // ------------------------------------------------------------------------------------------------------------

    /// @dev An unlimited approval to the arena can only ever be pulled by `join` / `pay` called by the approver
    ///      itself: nobody else (owner and server key included) can move an approver's tokens.
    function testAudit_unlimitedApprovalIsOnlyPulledByTheApprover() public {
        uint256 before = token.balanceOf(alice);
        // the owner and the server key have no function that calls transferFrom on a third party
        vm.prank(admin);
        arena.setPaused(false);
        vm.prank(bob);
        arena.join(OPEN);
        vm.prank(bob);
        arena.pay(1 ether, bytes32("x"));
        assertEq(token.balanceOf(alice), before, "alice's allowance was never used by someone else");
        assertEq(token.allowance(alice, address(arena)), type(uint256).max);
    }
}
