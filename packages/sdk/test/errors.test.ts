import { coinnibalArenaAbi, coinnibalNFTAbi, testTokenAbi } from '@coinnibal/contracts';
import {
  BaseError,
  ChainMismatchError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  InsufficientFundsError,
  UserRejectedRequestError,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { COINNIBAL_ERRORS_ABI, ERROR_MESSAGES, decodeRevertData, describeError, humanError } from '../src/errors';

function reverted(abi: typeof coinnibalArenaAbi | typeof coinnibalNFTAbi, errorName: string, args: unknown[] = []) {
  const data = encodeErrorResult({ abi, errorName, args } as never);
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: 'join' } as never);
  return new ContractFunctionExecutionError(cause, { abi, functionName: 'join', args: [1] } as never);
}

describe('errors', () => {
  it('every custom error of both contracts has a message', () => {
    for (const e of COINNIBAL_ERRORS_ABI) {
      if (/^(ERC721(Incorrect|Insufficient|Invalid(Approver|Operator|Owner|Receiver|Sender))|ERC2981InvalidToken|ERC20InvalidApprover|ERC20InvalidSender)/.test(e.name)) continue;
      expect(ERROR_MESSAGES[e.name], e.name).toBeTruthy();
    }
  });

  it('decodes arena and NFT custom errors through viem', () => {
    const d = describeError(reverted(coinnibalArenaAbi, 'ArenaFull'));
    expect(d).toMatchObject({ kind: 'contract', name: 'ArenaFull', message: ERROR_MESSAGES.ArenaFull });
    expect(describeError(reverted(coinnibalNFTAbi, 'NotAllowlisted')).name).toBe('NotAllowlisted');
    expect(describeError(reverted(coinnibalArenaAbi, 'HoldersOnly'))).toMatchObject({ kind: 'contract', name: 'HoldersOnly', message: ERROR_MESSAGES.HoldersOnly });
    const own = describeError(reverted(coinnibalArenaAbi, 'OwnableUnauthorizedAccount', ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8']));
    expect(own.name).toBe('OwnableUnauthorizedAccount');
    expect(own.args).toEqual(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8']);
  });

  it('decodes raw revert data from a wallet error object', () => {
    const data = encodeErrorResult({ abi: coinnibalNFTAbi, errorName: 'SoldOut' });
    expect(decodeRevertData(data)).toEqual({ name: 'SoldOut', args: [] });
    expect(describeError({ code: 3, message: 'execution reverted', data }).name).toBe('SoldOut');
    expect(describeError({ code: -32603, message: 'Internal', data: { code: 3, data } }).name).toBe('SoldOut');
    expect(decodeRevertData('0xdeadbeef')).toBeNull();
    // TestToken errors
    expect(decodeRevertData(encodeErrorResult({ abi: testTokenAbi, errorName: 'InvalidFaucet' }))).toEqual({ name: 'InvalidFaucet', args: [] });
    expect(decodeRevertData(encodeErrorResult({ abi: testTokenAbi, errorName: 'FaucetCooldown', args: [1234n] }))).toEqual({ name: 'FaucetCooldown', args: [1234n] });
    expect(ERROR_MESSAGES.InvalidFaucet).toBeTruthy();
  });

  it('decodes a custom error a node wrote into the message only (a wallet that passes no revert data on)', () => {
    // a Hardhat node's wording, as viem wraps it for `writeContract` (the 2026-11 play-test's expired permit)
    const hardhat = (selector: string) => `VM Exception while processing transaction: reverted with an unrecognized custom error (return data: ${selector})`;
    const cause = new ContractFunctionRevertedError({ abi: coinnibalArenaAbi, functionName: 'join', message: `Execution reverted with reason: ${hardhat('0x1a15a3cc')}.` } as never);
    const wrapped = new ContractFunctionExecutionError(cause, { abi: coinnibalArenaAbi, functionName: 'join', args: [1] } as never);
    expect(describeError(wrapped)).toMatchObject({ kind: 'contract', name: 'PermitExpired', message: ERROR_MESSAGES.PermitExpired });
    expect(describeError({ code: -32603, message: hardhat('0x096b0b8a') })).toMatchObject({ kind: 'contract', name: 'PermitTooFarAhead' });
    // Anvil's wording; arguments decoded too
    const withArgs = encodeErrorResult({ abi: testTokenAbi, errorName: 'FaucetCooldown', args: [1234n] });
    expect(describeError(new Error(`execution reverted: custom error ${withArgs}`))).toMatchObject({ name: 'FaucetCooldown', args: [1234n] });
    // data no ABI knows stays a plain revert
    expect(describeError(new Error(hardhat('0xdeadbeef'))).kind).toBe('revert');
  });

  it('classifies wallet errors', () => {
    expect(describeError({ code: 4001, message: 'User rejected the request.' }).kind).toBe('rejected');
    expect(describeError(new UserRejectedRequestError(new Error('x'))).kind).toBe('rejected');
    expect(describeError({ code: 4902, message: 'Unrecognized chain ID' }, { chainName: 'Robinhood Chain Testnet' }).message).toMatch(/Robinhood Chain Testnet/);
    expect(describeError(new ChainMismatchError({ chain: { id: 46630, name: 'Robinhood Chain Testnet' } as never, currentChainId: 1 })).kind).toBe('wrong-chain');
    expect(describeError(new InsufficientFundsError({ cause: new BaseError('insufficient funds for gas * price + value') })).kind).toBe('insufficient-funds');
    // a dev node's and viem's own wording, through a wallet that passes only the message on
    expect(describeError(new Error("Sender doesn't have enough funds to send tx. The max upfront cost is: 1 and the sender's account only has: 0")).kind).toBe('insufficient-funds');
    expect(describeError(new Error('The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.')).kind).toBe('insufficient-funds');
    expect(describeError({ code: -32002, message: 'Request already pending' }).kind).toBe('pending');
    expect(describeError(new Error('fetch failed')).kind).toBe('network');
    expect(describeError(new Error('execution reverted')).kind).toBe('revert');
    expect(describeError('weird').kind).toBe('unknown');
    expect(humanError({ code: 4001 })).toMatch(/declined/);
  });
});
