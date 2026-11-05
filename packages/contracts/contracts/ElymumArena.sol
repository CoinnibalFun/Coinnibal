// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HolderCheck} from "./HolderCheck.sol";

/// @title ElymumArena (version 3: fee on profit, burned on chain)
/// @notice Ticket escrow for the Elymum arenas. A player buys a ticket with `join`: the arena's whole entry fee goes
///         into the arena vault (there is no entry fee cut). At the bell the game server pays every ticket its in-game
///         value with `settle`. When that value is above the ticket's entry fee, a fee is taken from the PROFIT
///         (`payout - entryFee`): `burnBps` of it is burned and `vaultBps` of it goes to the fee wallet (defaults 15 %
///         and 5 %, together at most `MAX_TOTAL_FEE_BPS` = 25 %). A loss or a break-even pays no fee. A ticket that was
///         never played is cancelled by the server with `cancel` (full entry fee back), and a ticket the server never
///         settles can be refunded by its player after 24 h.
///         Holders of the Elymum emblem (`setHolderPerks`) may get their own (lower) rates and may enter holders-only
///         arenas.
/// @dev    Accounting is internal: `Arena.vault` is what settlements, cancels, refunds, loot burns and sweeps may
///         spend and `Arena.owed` is held for players whose transfer failed (two-phase settle). The contract's token
///         balance is always `sum(vault) + sum(owed)` plus anything sent to it directly (which stays locked: `rescue`
///         never touches the game token). Burning uses the token's own `burn(uint256)` when the owner turned that on
///         (`setBurnMode`) and the call really lowered the balance by the amount; otherwise (or as a fallback) the
///         tokens go to 0x…dEaD. No `immutable` variables, so the runtime bytecode is identical for every deployment.
contract ElymumArena is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Basis-point denominator (100 %).
    uint16 public constant BPS = 10_000;
    /// @notice Upper bound of `burnBps + vaultBps` (and of the holder pair): 25 % of the profit.
    uint16 public constant MAX_TOTAL_FEE_BPS = 2_500;
    /// @notice Share of the profit burned at deploy (15 %).
    uint16 public constant DEFAULT_BURN_BPS = 1_500;
    /// @notice Share of the profit sent to the fee wallet at deploy (5 %).
    uint16 public constant DEFAULT_VAULT_BPS = 500;
    /// @notice Contract version.
    uint16 public constant VERSION = 3;
    /// @notice Bounds of `Arena.maxSessions`.
    uint16 public constant MIN_ARENA_SESSIONS = 2;
    uint16 public constant MAX_ARENA_SESSIONS = 2_000;
    /// @notice A ticket that was never settled can be refunded by its player after this delay.
    uint64 public constant REFUND_DELAY = 24 hours;
    /// @notice Tokens are burned by sending them here unless the burn mode is `BURN_MODE_CALL` and the call works.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice `burnMode`: send burned tokens to `BURN_ADDRESS` (works with every ERC-20; the default).
    uint8 public constant BURN_MODE_DEAD = 0;
    /// @notice `burnMode`: call the token's `burn(uint256)` (ERC20Burnable), falling back to `BURN_ADDRESS`.
    uint8 public constant BURN_MODE_CALL = 1;

    /// @notice `SettleSkipped.reason`: the arena does not exist.
    uint8 public constant SKIP_UNKNOWN_ARENA = 1;
    /// @notice `SettleSkipped.reason`: no open session with this id (never opened, already settled or refunded).
    uint8 public constant SKIP_SESSION_MISMATCH = 2;
    /// @notice `SettleSkipped.reason`: the session is already settled and waits for the player to collect.
    uint8 public constant SKIP_FINALIZED = 3;
    /// @notice `SettleSkipped.reason`: the payout (or the cancelled entry fee) is larger than the arena vault.
    uint8 public constant SKIP_INSUFFICIENT_VAULT = 4;

    /// @dev `burn(uint256)` of ERC20Burnable.
    bytes4 private constant BURN_SELECTOR = 0x42966c68;

    // ------------------------------------------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------------------------------------------

    /// @dev 4 slots. Amounts are uint128 (checked arithmetic reverts long before a real token gets there).
    struct Arena {
        uint128 entryFee; //       slot 0
        uint128 vault; //          slot 0: spendable by settle / cancel / refund / sweepLoot / sweepArena
        uint128 owed; //           slot 1: reserved for finalized sessions (collected with `refund`)
        uint64 lastSweepId; //     slot 1
        uint16 maxSessions; //     slot 1
        uint16 openSessions; //    slot 1: joined and not yet settled, cancelled or refunded
        bool enabled; //           slot 1
        bool exists; //            slot 1
        bool holdersOnly; //       slot 1: `join` needs the holder NFT
        uint128 totalDeposited; // slot 2: entry fees paid in
        uint128 totalPaidOut; //   slot 2: what players got (net payouts, cancels, refunds; owed counts when finalized)
        uint128 totalBurned; //    slot 3: fee burns + loot burns
        uint128 totalFees; //      slot 3: fees sent to the fee wallet
    }

    /// @dev 2 slots. `id == 0` means no session. The fee rates are fixed at join.
    struct Session {
        uint64 id; //        slot 0
        uint40 openedAt; //  slot 0
        uint16 burnBps; //   slot 0
        uint16 vaultBps; //  slot 0
        bool finalized; //   slot 0: settled, the player's share is `owed`
        uint128 entryFee; // slot 1
        uint128 owed; //     slot 1
    }

    /// @notice One ticket of a `cancel` batch.
    struct SessionRef {
        uint16 arenaId;
        address player;
        uint64 sessionId;
    }

    /// @notice One settlement of a `settle` batch. `payout` is the ticket's in-game value (gross, before the fee).
    struct Settlement {
        uint16 arenaId;
        address player;
        uint64 sessionId;
        uint128 payout;
    }

    struct ConfigView {
        address admin;
        address pendingAdmin;
        address serverAuthority;
        address feeWallet;
        address token;
        uint8 decimals;
        uint16 burnBps;
        uint16 vaultBps;
        uint16 holderBurnBps;
        uint16 holderVaultBps;
        address holderNft;
        uint8 burnMode;
        bool paused;
        uint64 totalSessions;
        uint64 totalGames;
        uint128 totalStaked;
        uint128 totalPaidOut;
        uint128 totalFeeBurned;
        uint128 totalFeeToVault;
        uint128 totalLootBurned;
    }

    struct ArenaView {
        uint16 id;
        uint128 entryFee;
        uint128 vault;
        uint128 owed;
        uint16 maxSessions;
        uint16 openSessions;
        bool enabled;
        bool exists;
        bool holdersOnly;
        uint64 lastSweepId;
        uint128 totalDeposited;
        uint128 totalPaidOut;
        uint128 totalBurned;
        uint128 totalFees;
    }

    struct SessionView {
        uint64 id;
        uint128 entryFee;
        uint64 openedAt;
        uint16 burnBps;
        uint16 vaultBps;
        bool finalized;
        uint128 owed;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------------------

    // slot: server (20) + burnBps (2) + vaultBps (2) + paused (1) + decimals (1) + burnMode (1) = 27
    address private _serverAuthority;
    uint16 private _burnBps;
    uint16 private _vaultBps;
    bool private _paused;
    uint8 private _decimals;
    uint8 private _burnMode;

    // slot: feeWallet (20) + lastSessionId (8)
    address private _feeWallet;
    uint64 private _lastSessionId;

    // slot: token (20) + totalGames (8)
    IERC20 private _token;
    uint64 private _totalGames;

    // slot: holderNft (20) + holderBurnBps (2) + holderVaultBps (2)
    address private _holderNft;
    uint16 private _holderBurnBps;
    uint16 private _holderVaultBps;

    uint128 private _totalStaked;
    uint128 private _totalPaidOut;
    uint128 private _totalFeeBurned;
    uint128 private _totalFeeToVault;
    uint128 private _totalLootBurned;

    uint16[] private _arenaIds;
    mapping(uint16 arenaId => Arena) private _arenas;
    mapping(uint16 arenaId => mapping(address player => Session)) private _sessions;

    // ------------------------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------------------------

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
    /// @dev The ticket's fee rates (on profit) are fixed here.
    event Joined(
        uint16 indexed arenaId,
        address indexed player,
        uint64 indexed sessionId,
        uint128 entryFee,
        uint16 burnBps,
        uint16 vaultBps
    );
    /// @param payout    the ticket's in-game value (gross).
    /// @param net       what the player gets: `payout - burned - toVault`.
    /// @param burned    the burned share of the profit.
    /// @param toVault   the fee wallet's share of the profit.
    /// @param collected true when `net` was transferred now; false when it is held as `owed`.
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
    /// @notice The fee burns of one `settle` batch. `viaBurnCall`: the token's `burn()` (else sent to 0x…dEaD).
    event FeeBurned(uint128 amount, bool viaBurnCall);
    /// @notice The fee wallet's share of one `settle` batch.
    event FeeToVault(address indexed feeWallet, uint128 amount);
    /// @notice A ticket that was never played, closed by the server: the full entry fee goes back.
    event Cancelled(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 amount, bool collected);
    event SettleSkipped(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint8 reason);
    event Refunded(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 amount);
    event Collected(uint16 indexed arenaId, address indexed player, uint64 indexed sessionId, uint128 amount);
    event LootBurned(uint16 indexed arenaId, uint64 indexed sweepId, uint128 amount, bool viaBurnCall);
    event ArenaSwept(uint16 indexed arenaId, address indexed feeWallet, uint128 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error NotServer();
    error Paused();
    error TokenNotSet();
    error TokenAlreadySet();
    error NotAContract();
    error InvalidFee();
    error InvalidBurnMode();
    error InvalidArenaId();
    error ArenaExists();
    error UnknownArena();
    error EntryFeeZero();
    error InvalidMaxSessions();
    error ArenaBusy();
    error ArenaDisabled();
    error ArenaEnabled();
    error ArenaFull();
    error ArenaHasOpenSessions();
    error SessionExists();
    error NoSession();
    error RefundTooEarly();
    error InsufficientVault();
    error FeeOnTransferToken();
    error BurnMismatch();
    error SweepIdNotIncreasing();
    error CannotRescueGameToken();
    error NativeTransferFailed();
    error RenounceDisabled();
    error HoldersOnly();

    // ------------------------------------------------------------------------------------------------------------
    // Constructor & modifiers
    // ------------------------------------------------------------------------------------------------------------

    /// @param admin           Owner (Ownable2Step): configures the contract, creates and sweeps arenas.
    /// @param serverAuthority Game server key: calls `settle`, `cancel` and `sweepLoot`.
    /// @param feeWallet       Receives the fee wallet's share of every profit and every swept arena vault.
    constructor(address admin, address serverAuthority, address feeWallet) Ownable(admin) {
        if (serverAuthority == address(0) || feeWallet == address(0)) revert ZeroAddress();
        _serverAuthority = serverAuthority;
        _feeWallet = feeWallet;
        _burnBps = DEFAULT_BURN_BPS;
        _vaultBps = DEFAULT_VAULT_BPS;
        _holderBurnBps = DEFAULT_BURN_BPS;
        _holderVaultBps = DEFAULT_VAULT_BPS;
        emit ServerAuthoritySet(serverAuthority);
        emit FeeWalletSet(feeWallet);
        emit FeeRatesSet(DEFAULT_BURN_BPS, DEFAULT_VAULT_BPS);
    }

    modifier onlyServer() {
        if (msg.sender != _serverAuthority) revert NotServer();
        _;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Sets the game token, once. Reads `decimals()` (default 18 if the call fails).
    /// @dev    The token must be a plain ERC-20: no transfer fees (a join refuses them), no rebasing, and no transfer
    ///         hooks that call the recipient (a hook could burn the gas of a `settle` batch).
    function setToken(address token) external onlyOwner {
        if (address(_token) != address(0)) revert TokenAlreadySet();
        if (token == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert NotAContract();
        uint8 dec = 18;
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            dec = d;
        } catch {}
        _token = IERC20(token);
        _decimals = dec;
        emit TokenSet(token, dec);
    }

    /// @notice Fee rates on the profit of new tickets, in bps: `burnBps + vaultBps <= MAX_TOTAL_FEE_BPS`.
    ///         Open tickets keep the rates they joined with.
    function setFeeRates(uint16 burnBps, uint16 vaultBps) external onlyOwner {
        if (uint256(burnBps) + vaultBps > MAX_TOTAL_FEE_BPS) revert InvalidFee();
        _burnBps = burnBps;
        _vaultBps = vaultBps;
        emit FeeRatesSet(burnBps, vaultBps);
    }

    /// @notice How burns are done: `BURN_MODE_DEAD` (send to 0x…dEaD) or `BURN_MODE_CALL` (the token's `burn`, with
    ///         0x…dEaD as the fallback when the call fails or does nothing).
    function setBurnMode(uint8 mode) external onlyOwner {
        if (mode > BURN_MODE_CALL) revert InvalidBurnMode();
        _burnMode = mode;
        emit BurnModeSet(mode);
    }

    function setFeeWallet(address w) external onlyOwner {
        if (w == address(0)) revert ZeroAddress();
        _feeWallet = w;
        emit FeeWalletSet(w);
    }

    function setServerAuthority(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        _serverAuthority = s;
        emit ServerAuthoritySet(s);
    }

    /// @notice Pausing blocks `join` only: settlements, cancels, refunds and sweeps keep working.
    function setPaused(bool p) external onlyOwner {
        _paused = p;
        emit PausedSet(p);
    }

    /// @notice Creates an enabled arena. Needs the token. `id` must be non-zero and unused.
    function createArena(uint16 id, uint128 entryFee, uint16 maxSessions) external onlyOwner {
        if (address(_token) == address(0)) revert TokenNotSet();
        if (id == 0) revert InvalidArenaId();
        Arena storage a = _arenas[id];
        if (a.exists) revert ArenaExists();
        _checkArenaParams(entryFee, maxSessions);
        a.exists = true;
        a.enabled = true;
        a.entryFee = entryFee;
        a.maxSessions = maxSessions;
        _arenaIds.push(id);
        emit ArenaCreated(id, entryFee, maxSessions);
    }

    /// @notice Updates an arena. The entry fee can change only while no ticket is open (`ArenaBusy`).
    function updateArena(uint16 id, uint128 entryFee, uint16 maxSessions, bool enabled) external onlyOwner {
        Arena storage a = _arenas[id];
        if (!a.exists) revert UnknownArena();
        _checkArenaParams(entryFee, maxSessions);
        if (entryFee != a.entryFee && a.openSessions != 0) revert ArenaBusy();
        a.entryFee = entryFee;
        a.maxSessions = maxSessions;
        a.enabled = enabled;
        emit ArenaUpdated(id, entryFee, maxSessions, enabled);
    }

    /// @notice Holder perks: wallets holding at least one token of `nft` (an ERC-721) join with the holder rates when
    ///         those total less than the normal rates, and may enter holders-only arenas. `nft == address(0)` turns the
    ///         perks off (and then nobody can enter a holders-only arena). The holder pair has the same cap.
    /// @dev    A broken or hostile `nft` can never block a join: the balance check never reverts (see HolderCheck).
    function setHolderPerks(address nft, uint16 holderBurnBps, uint16 holderVaultBps) external onlyOwner {
        if (uint256(holderBurnBps) + holderVaultBps > MAX_TOTAL_FEE_BPS) revert InvalidFee();
        if (nft != address(0) && nft.code.length == 0) revert NotAContract();
        _holderNft = nft;
        _holderBurnBps = holderBurnBps;
        _holderVaultBps = holderVaultBps;
        emit HolderPerksSet(nft, holderBurnBps, holderVaultBps);
    }

    /// @notice Marks an arena as holders-only (`join` reverts `HoldersOnly` for wallets without the holder NFT).
    ///         Open tickets are not affected.
    function setArenaHoldersOnly(uint16 id, bool holdersOnly) external onlyOwner {
        Arena storage a = _arenas[id];
        if (!a.exists) revert UnknownArena();
        a.holdersOnly = holdersOnly;
        emit ArenaHoldersOnlySet(id, holdersOnly);
    }

    /// @notice Sends the whole vault of a disabled arena with no open ticket to the fee wallet. Owed payouts of
    ///         finalized sessions stay reserved for their players.
    function sweepArena(uint16 id) external onlyOwner nonReentrant {
        Arena storage a = _arenas[id];
        if (!a.exists) revert UnknownArena();
        if (a.enabled) revert ArenaEnabled();
        if (a.openSessions != 0) revert ArenaHasOpenSessions();
        uint128 amount = a.vault;
        a.vault = 0;
        address to = _feeWallet;
        if (amount != 0) _token.safeTransfer(to, amount);
        emit ArenaSwept(id, to, amount);
    }

    /// @notice Recovers the gas token (`token == address(0)`) or a foreign ERC-20 sent here by mistake. Never the
    ///         game token.
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            if (token == address(_token)) revert CannotRescueGameToken();
            IERC20(token).safeTransfer(to, amount);
        }
        emit Rescued(token, to, amount);
    }

    /// @notice Disabled: an ownerless arena could never be swept or reconfigured.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Players
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Buys a ticket: pulls the arena's entry fee (the exact amount must arrive, so fee-on-transfer tokens are
    ///         refused) into the vault and opens a session with the current fee rates (the holder rates for holders
    ///         when they are lower). Holders-only arenas refuse other wallets (`HoldersOnly`).
    function join(uint16 arenaId) external nonReentrant {
        if (_paused) revert Paused();
        IERC20 token = _token;
        if (address(token) == address(0)) revert TokenNotSet();
        Arena storage a = _arenas[arenaId];
        if (!a.exists) revert UnknownArena();
        if (!a.enabled) revert ArenaDisabled();
        if (a.openSessions >= a.maxSessions) revert ArenaFull();
        Session storage s = _sessions[arenaId][msg.sender];
        if (s.id != 0) revert SessionExists();
        bool holder = _holderNft != address(0) && HolderCheck.isHolder(_holderNft, msg.sender);
        if (a.holdersOnly && !holder) revert HoldersOnly();
        (uint16 burnBps, uint16 vaultBps) = _ratesFor(holder);

        uint128 entryFee = a.entryFee;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), entryFee);
        if (token.balanceOf(address(this)) - before != entryFee) revert FeeOnTransferToken();

        uint64 sessionId = ++_lastSessionId;
        s.id = sessionId;
        s.openedAt = uint40(block.timestamp);
        s.burnBps = burnBps;
        s.vaultBps = vaultBps;
        s.finalized = false;
        s.entryFee = entryFee;
        s.owed = 0;

        a.vault += entryFee;
        a.openSessions += 1;
        a.totalDeposited += entryFee;
        _totalStaked += entryFee;

        emit Joined(arenaId, msg.sender, sessionId, entryFee, burnBps, vaultBps);
    }

    /// @notice Finalized session: collects `owed` at once. Otherwise, 24 h after joining (the server never settled
    ///         it): refunds `min(entryFee, vault)` (no fee) and closes the ticket.
    function refund(uint16 arenaId) external nonReentrant {
        Session storage s = _sessions[arenaId][msg.sender];
        uint64 sessionId = s.id;
        if (sessionId == 0) revert NoSession();
        Arena storage a = _arenas[arenaId];

        if (s.finalized) {
            uint128 owed = s.owed;
            delete _sessions[arenaId][msg.sender];
            a.owed -= owed;
            if (owed != 0) _token.safeTransfer(msg.sender, owed);
            emit Collected(arenaId, msg.sender, sessionId, owed);
            return;
        }

        if (block.timestamp < uint256(s.openedAt) + REFUND_DELAY) revert RefundTooEarly();
        uint128 amount = s.entryFee;
        if (amount > a.vault) amount = a.vault;
        delete _sessions[arenaId][msg.sender];
        a.vault -= amount;
        a.openSessions -= 1;
        a.totalPaidOut += amount;
        _totalPaidOut += amount;
        if (amount != 0) _token.safeTransfer(msg.sender, amount);
        emit Refunded(arenaId, msg.sender, sessionId, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Server
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Settles a batch. Each ticket's `payout` (its gross in-game value) leaves the vault: the fee on its
    ///         profit is split into a burn and the fee wallet's share, and the rest goes to the player. The batch's
    ///         burns and fee-wallet shares are summed and moved once at the end (a failing burn or fee transfer
    ///         reverts the whole batch). An item that cannot be settled is skipped with `SettleSkipped(reason)`. When
    ///         the player's transfer fails the session is finalized and the net payout is held as `owed`.
    function settle(Settlement[] calldata items) external onlyServer nonReentrant {
        IERC20 token = _token;
        uint256 n = items.length;
        uint128 burnSum;
        uint128 vaultSum;
        for (uint256 i; i < n; ++i) {
            (uint128 b, uint128 v) = _settleOne(token, items[i]);
            burnSum += b;
            vaultSum += v;
        }
        if (burnSum != 0) {
            bool viaCall = _burnTokens(token, burnSum);
            emit FeeBurned(burnSum, viaCall);
        }
        if (vaultSum != 0) {
            address w = _feeWallet;
            token.safeTransfer(w, vaultSum);
            emit FeeToVault(w, vaultSum);
        }
    }

    /// @notice Cancels tickets that were never played (bought, never seated in a room): each gets its full entry fee
    ///         back. Skips like `settle` (`SettleSkipped`); a failed transfer finalizes the session with the amount held
    ///         as `owed`.
    function cancel(SessionRef[] calldata items) external onlyServer nonReentrant {
        IERC20 token = _token;
        uint256 n = items.length;
        for (uint256 i; i < n; ++i) {
            _cancelOne(token, items[i]);
        }
    }

    /// @notice Burns floor loot of an arena. `sweepId` must be larger than the last one, so a retried sweep can never
    ///         burn twice.
    function sweepLoot(uint16 arenaId, uint64 sweepId, uint128 amount) external onlyServer nonReentrant {
        Arena storage a = _arenas[arenaId];
        if (!a.exists) revert UnknownArena();
        if (sweepId <= a.lastSweepId) revert SweepIdNotIncreasing();
        if (amount > a.vault) revert InsufficientVault();
        a.lastSweepId = sweepId;
        a.vault -= amount;
        a.totalBurned += amount;
        _totalLootBurned += amount;
        bool viaCall = amount != 0 && _burnTokens(_token, amount);
        emit LootBurned(arenaId, sweepId, amount, viaCall);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    function config() external view returns (ConfigView memory v) {
        v.admin = owner();
        v.pendingAdmin = pendingOwner();
        v.serverAuthority = _serverAuthority;
        v.feeWallet = _feeWallet;
        v.token = address(_token);
        v.decimals = _decimals;
        v.burnBps = _burnBps;
        v.vaultBps = _vaultBps;
        v.holderBurnBps = _holderBurnBps;
        v.holderVaultBps = _holderVaultBps;
        v.holderNft = _holderNft;
        v.burnMode = _burnMode;
        v.paused = _paused;
        v.totalSessions = _lastSessionId;
        v.totalGames = _totalGames;
        v.totalStaked = _totalStaked;
        v.totalPaidOut = _totalPaidOut;
        v.totalFeeBurned = _totalFeeBurned;
        v.totalFeeToVault = _totalFeeToVault;
        v.totalLootBurned = _totalLootBurned;
    }

    function arenaIds() external view returns (uint16[] memory) {
        return _arenaIds;
    }

    function getArena(uint16 id) external view returns (ArenaView memory v) {
        Arena storage a = _arenas[id];
        v.id = id;
        v.entryFee = a.entryFee;
        v.vault = a.vault;
        v.owed = a.owed;
        v.maxSessions = a.maxSessions;
        v.openSessions = a.openSessions;
        v.enabled = a.enabled;
        v.exists = a.exists;
        v.holdersOnly = a.holdersOnly;
        v.lastSweepId = a.lastSweepId;
        v.totalDeposited = a.totalDeposited;
        v.totalPaidOut = a.totalPaidOut;
        v.totalBurned = a.totalBurned;
        v.totalFees = a.totalFees;
    }

    function getSession(uint16 arenaId, address player) external view returns (SessionView memory v) {
        Session storage s = _sessions[arenaId][player];
        v.id = s.id;
        v.entryFee = s.entryFee;
        v.openedAt = s.openedAt;
        v.burnBps = s.burnBps;
        v.vaultBps = s.vaultBps;
        v.finalized = s.finalized;
        v.owed = s.owed;
    }

    /// @notice True when `player` holds the holder NFT (false when the perks are off or the NFT misbehaves).
    function isHolder(address player) public view returns (bool) {
        return HolderCheck.isHolder(_holderNft, player);
    }

    /// @notice The fee rates a ticket bought by `player` now would get.
    function feeRatesFor(address player) external view returns (uint16 burnBps, uint16 vaultBps) {
        return _ratesFor(isHolder(player));
    }

    /// @notice The fee of a payout: `profit = max(0, payout - entryFee)`, `burned = floor(profit * burnBps / 10 000)`,
    ///         `toVault = floor(profit * vaultBps / 10 000)`, `net = payout - burned - toVault`.
    function computeFees(uint128 entryFee, uint128 payout, uint16 burnBps, uint16 vaultBps)
        public
        pure
        returns (uint128 net, uint128 burned, uint128 toVault)
    {
        uint256 profit = payout > entryFee ? uint256(payout) - entryFee : 0;
        burned = uint128((profit * burnBps) / BPS);
        toVault = uint128((profit * vaultBps) / BPS);
        net = payout - burned - toVault;
    }

    function version() external pure returns (uint16) {
        return VERSION;
    }

    function burnMode() external view returns (uint8) {
        return _burnMode;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------------

    function _ratesFor(bool holder) private view returns (uint16 burnBps, uint16 vaultBps) {
        burnBps = _burnBps;
        vaultBps = _vaultBps;
        if (holder && uint256(_holderBurnBps) + _holderVaultBps < uint256(burnBps) + vaultBps) {
            burnBps = _holderBurnBps;
            vaultBps = _holderVaultBps;
        }
    }

    /// @return burned  the item's burn (0 when skipped)
    /// @return toVault the item's fee-wallet share (0 when skipped)
    function _settleOne(IERC20 token, Settlement calldata it) private returns (uint128 burned, uint128 toVault) {
        Arena storage a = _arenas[it.arenaId];
        if (!a.exists) return _skip(it.arenaId, it.player, it.sessionId, SKIP_UNKNOWN_ARENA);
        Session storage s = _sessions[it.arenaId][it.player];
        if (s.id == 0 || s.id != it.sessionId) return _skip(it.arenaId, it.player, it.sessionId, SKIP_SESSION_MISMATCH);
        if (s.finalized) return _skip(it.arenaId, it.player, it.sessionId, SKIP_FINALIZED);
        uint128 payout = it.payout;
        if (payout > a.vault) return _skip(it.arenaId, it.player, it.sessionId, SKIP_INSUFFICIENT_VAULT);

        uint128 net;
        (net, burned, toVault) = computeFees(s.entryFee, payout, s.burnBps, s.vaultBps);

        a.vault -= payout;
        a.openSessions -= 1;
        a.totalPaidOut += net;
        a.totalBurned += burned;
        a.totalFees += toVault;
        _totalPaidOut += net;
        _totalFeeBurned += burned;
        _totalFeeToVault += toVault;
        _totalGames += 1;

        bool collected = _payOrHold(token, a, s, it.player, net);
        emit Settled(it.arenaId, it.player, it.sessionId, payout, net, burned, toVault, collected);
    }

    function _cancelOne(IERC20 token, SessionRef calldata it) private {
        Arena storage a = _arenas[it.arenaId];
        if (!a.exists) {
            _skip(it.arenaId, it.player, it.sessionId, SKIP_UNKNOWN_ARENA);
            return;
        }
        Session storage s = _sessions[it.arenaId][it.player];
        if (s.id == 0 || s.id != it.sessionId) {
            _skip(it.arenaId, it.player, it.sessionId, SKIP_SESSION_MISMATCH);
            return;
        }
        if (s.finalized) {
            _skip(it.arenaId, it.player, it.sessionId, SKIP_FINALIZED);
            return;
        }
        uint128 entryFee = s.entryFee;
        if (entryFee > a.vault) {
            _skip(it.arenaId, it.player, it.sessionId, SKIP_INSUFFICIENT_VAULT);
            return;
        }
        a.vault -= entryFee;
        a.openSessions -= 1;
        a.totalPaidOut += entryFee;
        _totalPaidOut += entryFee;

        bool collected = _payOrHold(token, a, s, it.player, entryFee);
        emit Cancelled(it.arenaId, it.player, it.sessionId, entryFee, collected);
    }

    /// @dev Pays a closed ticket. Effects first: the session is marked finalized with `amount` owed (and the arena
    ///      holds it as `owed`) before the transfer; when the transfer succeeds the session is deleted and the hold
    ///      released, when it fails the hold stays (two-phase settle: the result is final, the player collects it
    ///      with `refund`). The caller has already taken `amount` out of the vault.
    function _payOrHold(IERC20 token, Arena storage a, Session storage s, address player, uint128 amount)
        private
        returns (bool)
    {
        s.finalized = true;
        s.owed = amount;
        a.owed += amount;
        if (amount != 0 && !token.trySafeTransfer(player, amount)) return false;
        a.owed -= amount;
        delete s.id;
        delete s.openedAt;
        delete s.burnBps;
        delete s.vaultBps;
        delete s.finalized;
        delete s.entryFee;
        delete s.owed;
        return true;
    }

    /// @dev Burns `amount` of the contract's own tokens. With `BURN_MODE_CALL` it calls the token's `burn(amount)` and
    ///      accepts it only if the balance fell by exactly `amount`; a call that fails or leaves the balance unchanged
    ///      falls back to a transfer to `BURN_ADDRESS`, and any other balance change reverts (`BurnMismatch`).
    /// @return viaCall true when the token's `burn` did it.
    function _burnTokens(IERC20 token, uint256 amount) private returns (bool viaCall) {
        if (_burnMode == BURN_MODE_CALL) {
            uint256 before = token.balanceOf(address(this));
            (bool ok,) = address(token).call(abi.encodeWithSelector(BURN_SELECTOR, amount));
            uint256 afterBal = token.balanceOf(address(this));
            if (ok && afterBal + amount == before) return true;
            if (afterBal != before) revert BurnMismatch();
        }
        token.safeTransfer(BURN_ADDRESS, amount);
        return false;
    }

    function _skip(uint16 arenaId, address player, uint64 sessionId, uint8 reason) private returns (uint128, uint128) {
        emit SettleSkipped(arenaId, player, sessionId, reason);
        return (0, 0);
    }

    function _checkArenaParams(uint128 entryFee, uint16 maxSessions) private pure {
        if (entryFee == 0) revert EntryFeeZero();
        if (maxSessions < MIN_ARENA_SESSIONS || maxSessions > MAX_ARENA_SESSIONS) revert InvalidMaxSessions();
    }
}
