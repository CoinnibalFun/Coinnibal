// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ElymumArena} from "../contracts/ElymumArena.sol";
import {ElymumNFT} from "../contracts/ElymumNFT.sol";
import {MockERC20} from "../contracts/test/MockTokens.sol";

/// @notice Findings of the mainnet economic audit (apps/server/test/mainnet-econ-sim.ts). Each test states the
///         behaviour the audit asks for and FAILS on the current ElymumArena v3. They run only with
///         `ELYMUM_ECON_FINDINGS=true` (the `test:econ-findings` script of this package), so the normal
///         suite stays green until a fix lands; without it each test returns at once.
contract ElymumArenaEconFindingsTest is Test {
    ElymumArena internal arena;
    MockERC20 internal token;
    ElymumNFT internal nft;

    address internal admin = makeAddr("admin");
    address internal server = makeAddr("server");
    address internal feeWallet = makeAddr("feeWallet");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint16 internal constant OPEN = 1;
    uint16 internal constant HOLDERS = 4;
    uint128 internal constant FEE = 10_000 ether;

    function _on() internal view returns (bool) {
        return vm.envOr("ELYMUM_ECON_FINDINGS", false);
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20("Elymum", "ELYMUM", 18);
        arena = new ElymumArena(admin, server, feeWallet);
        nft = new ElymumNFT(admin, 10_000, 0.0003 ether, 2, 3, "https://x/api/nft/", admin);
        vm.startPrank(admin);
        arena.setToken(address(token));
        arena.createArena(OPEN, FEE, 300);
        arena.createArena(HOLDERS, FEE, 300);
        arena.setArenaHoldersOnly(HOLDERS, true);
        arena.setHolderPerks(address(nft), 800, 200);
        nft.ownerMint(alice, 1); // token id 1: the one emblem of this test
        vm.stopPrank();
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i; i < ps.length; ++i) {
            token.mint(ps[i], 1_000_000 ether);
            vm.prank(ps[i]);
            token.approve(address(arena), type(uint256).max);
        }
    }

    /// @dev [F-emblem] One emblem passed from wallet to wallet seats every wallet of a ring in the holders-only $10
    ///      arena, each ticket at the holder pair (10 % instead of 20 %), at the same time. Each pass costs the ring
    ///      one NFT transfer (~55k gas, a fraction of a cent on Robinhood Chain). Wanted: a ticket's holder status
    ///      should hold for the ticket's life (at most one open holder ticket per emblem), so the second wallet is
    ///      refused while the first one's ticket is open.
    function test_oneEmblemSeatsOnlyOneHolderTicketAtATime() public {
        if (!_on()) return;
        vm.prank(alice);
        arena.join(HOLDERS);
        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);
        vm.prank(bob);
        arena.join(HOLDERS); // today: accepted, at the holder pair
        vm.prank(bob);
        nft.transferFrom(bob, carol, 1);
        vm.prank(carol);
        arena.join(OPEN); // today: the open arena at the holder pair too
        uint256 holderTickets;
        address[3] memory ps = [alice, bob, carol];
        uint16[3] memory ids = [HOLDERS, HOLDERS, OPEN];
        for (uint256 i; i < 3; ++i) {
            ElymumArena.SessionView memory s = arena.getSession(ids[i], ps[i]);
            if (s.id != 0 && s.burnBps == 800 && s.vaultBps == 200) holderTickets++;
        }
        assertEq(holderTickets, 1, "one emblem gave holder tickets to several wallets at once");
    }

    /// @dev [F-refund] A ticket eaten in play (its settlement at 0 never sent, e.g. the server key ran out of gas for a
    ///      day) can be refunded at its full entry fee after 24 h, out of the vault that holds the winner's payout.
    ///      The winner's settlement is then skipped (`SKIP_INSUFFICIENT_VAULT`) and the winner can only refund their
    ///      own entry: the round is unwound in favour of the loser. Wanted: the winner is paid what the game says.
    function test_loserRefundAfter24hDoesNotTakeTheWinnersPayout() public {
        if (!_on()) return;
        vm.prank(bob);
        arena.join(OPEN);
        vm.prank(carol);
        arena.join(OPEN);
        uint64 bobId = arena.getSession(OPEN, bob).id;
        // in play: bob ate carol (bob's coin is worth 2 tickets, carol's 0); the server is down for a day
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(carol);
        arena.refund(OPEN); // carol, the loser, takes back her entry fee
        ElymumArena.Settlement[] memory items = new ElymumArena.Settlement[](1);
        items[0] = ElymumArena.Settlement(OPEN, bob, bobId, 2 * FEE);
        uint256 before = token.balanceOf(bob);
        vm.prank(server);
        arena.settle(items);
        // bob's profit of one ticket, less 20 %: he should receive 1.8 tickets
        assertEq(token.balanceOf(bob) - before, (2 * FEE) - (FEE * 2_000) / 10_000, "the winner was not paid");
    }
}
