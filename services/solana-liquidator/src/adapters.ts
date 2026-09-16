import { SOLANA_USDC_MINT } from '@katon/solana-core';
import type { AssetRegistryEntry } from '@katon/solana-core';
import { MAINNET_PROGRAM_IDS } from './manifest';
import type { ManifestMarketIdentity } from './manifest';

export type LenderName = ManifestMarketIdentity['lender'];

export interface LendingPosition {
  readonly obligationAddress: string;
  readonly owner: string;
  readonly collateralMint: string;
  readonly collateralAtomic: string;
  readonly debtMint: string;
  readonly debtAtomic: string;
  readonly healthFactorBps: number;
  readonly observedAtMs: number;
}

export interface DiscoveredMarket extends ManifestMarketIdentity {
  readonly marketAddress: string;
  readonly reserveAddress: string;
  readonly vaultAddress: string;
  readonly collateralMint: string;
  readonly debtMint: string;
  readonly oracleAddress: string;
  readonly observedAtMs: number;
}

export interface LiquidationInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly dataBase64: string;
  /** True only when produced by the lender's pinned authoritative SDK/IDL. */
  readonly authoritative: true;
}

export interface LenderAdapter {
  readonly name: LenderName;
  readonly programId: string;
  discoverMarkets(): Promise<readonly DiscoveredMarket[]>;
  buildLiquidationInstruction(position: LendingPosition, market: DiscoveredMarket): Promise<LiquidationInstruction>;
}

export interface FlashloanAdapter {
  readonly programId: string;
  buildFlashloanInstruction(amountAtomic: string, tokenMint?: string): Promise<LiquidationInstruction>;
}

type MarketDiscovery = () => Promise<readonly DiscoveredMarket[]>;
type AuthoritativeLiquidationBuilder = (position: LendingPosition, market: DiscoveredMarket) => Promise<LiquidationInstruction>;
type AuthoritativeFlashloanBuilder = (amountAtomic: string, tokenMint: string) => Promise<LiquidationInstruction>;

/**
 * These adapters intentionally contain no web3.js v1 types. Production
 * implementations are generated from the reviewed Anchor/Codama IDL and
 * should fail closed if discovery returns a different address or hash.
 */
abstract class PinnedLenderAdapter implements LenderAdapter {
  abstract readonly name: LenderName;
  abstract readonly programId: string;
  private readonly discover: MarketDiscovery;
  private readonly build?: AuthoritativeLiquidationBuilder;

  constructor(discover?: MarketDiscovery, build?: AuthoritativeLiquidationBuilder) {
    this.discover = discover ?? (async () => {
      throw new Error('authoritative lender discovery is not configured');
    });
    this.build = build;
  }

  async discoverMarkets(): Promise<readonly DiscoveredMarket[]> {
    const markets = await this.discover();
    for (const market of markets) {
      if (market.lender !== this.name || market.programId !== this.programId) {
        throw new Error(`${this.name} discovery returned an unreviewed lender market`);
      }
      assertMarketMetadata(market);
    }
    return markets;
  }

  async buildLiquidationInstruction(position: LendingPosition, market: DiscoveredMarket): Promise<LiquidationInstruction> {
    assertMarketForPosition(position, market, this.name, this.programId);
    if (!this.build) throw new Error(`${this.name} authoritative liquidation builder is not configured`);
    const instruction = await this.build(position, market);
    assertAuthoritativeInstruction(instruction, this.programId);
    return instruction;
  }
}

export class KaminoLendAdapter extends PinnedLenderAdapter {
  readonly name = 'kamino' as const;
  readonly programId = MAINNET_PROGRAM_IDS.kamino;
}

export class JupiterLendAdapter extends PinnedLenderAdapter {
  readonly name = 'jupiter-lend' as const;
  readonly programId = MAINNET_PROGRAM_IDS.jupiterLend;
}

export class JupiterFlashloanAdapter implements FlashloanAdapter {
  readonly programId = MAINNET_PROGRAM_IDS.jupiterFlashloan;

  constructor(private readonly build?: AuthoritativeFlashloanBuilder) {}

  async buildFlashloanInstruction(amountAtomic: string, tokenMint = SOLANA_USDC_MINT): Promise<LiquidationInstruction> {
    if (!/^(0|[1-9][0-9]*)$/.test(amountAtomic) || amountAtomic === '0') throw new Error('flashloan amount must be a positive atomic string');
    if (!this.build) throw new Error('authoritative flashloan builder is not configured');
    const instruction = await this.build(amountAtomic, tokenMint);
    assertAuthoritativeInstruction(instruction, this.programId);
    return instruction;
  }
}

function assertMarketMetadata(market: DiscoveredMarket): void {
  if (!market.marketAddress || !market.reserveAddress || !market.vaultAddress || !market.collateralMint || !market.debtMint || !market.oracleAddress || !market.idlSha256 || !market.bytecodeSha256 || !market.upgradeAuthority) {
    throw new Error('market discovery is incomplete');
  }
}

function assertAuthoritativeInstruction(instruction: LiquidationInstruction, programId: string): void {
  const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(instruction.dataBase64)
    ? Buffer.from(instruction.dataBase64, 'base64')
    : undefined;
  if (instruction.programId !== programId || instruction.authoritative !== true || instruction.accounts.length === 0 || instruction.accounts.some((account) => !account) || !decoded || decoded.length === 0 || decoded.toString('base64') !== instruction.dataBase64) {
    throw new Error('authoritative instruction is invalid or unverified');
  }
}

export function assertMarketForPosition(position: LendingPosition, market: DiscoveredMarket, lender: LenderName, programId: string): void {
  if (market.lender !== lender || market.programId !== programId) throw new Error('lender market is not pinned to the expected program');
  if (position.collateralMint !== market.collateralMint || position.debtMint !== market.debtMint) throw new Error('position mint does not match discovered market');
  if (position.debtMint !== SOLANA_USDC_MINT && position.debtMint !== 'native-usdc') throw new Error('liquidations require native USDC debt');
  if (!position.obligationAddress || !position.owner || !market.marketAddress || !market.reserveAddress || !market.vaultAddress || !market.oracleAddress || !market.idlSha256 || !market.bytecodeSha256 || !market.upgradeAuthority) throw new Error('position or market accounts are incomplete');
}

export function verifyDiscoveredMarkets(
  markets: readonly DiscoveredMarket[],
  assets: readonly AssetRegistryEntry[],
  nowMs: number,
  maxAgeMs = 30_000,
  marketVerifier?: (market: DiscoveredMarket) => { readonly ok: boolean; readonly reason?: string },
): { readonly ok: boolean; readonly reason?: string } {
  if (markets.length === 0) return { ok: false, reason: 'no reviewed lender markets discovered' };
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return { ok: false, reason: 'invalid discovery clock' };
  const enabledMints = new Set(assets.filter((asset) => asset.enabled).map((asset) => asset.mint));
  const reviewedProgramIds: readonly string[] = [MAINNET_PROGRAM_IDS.kamino, MAINNET_PROGRAM_IDS.jupiterLend];
  for (const market of markets) {
    if (market.lender !== 'kamino' && market.lender !== 'jupiter-lend') return { ok: false, reason: 'unreviewed lender' };
    if (!reviewedProgramIds.includes(market.programId)) return { ok: false, reason: 'unreviewed lender program' };
    if ((market.lender === 'kamino' && market.programId !== MAINNET_PROGRAM_IDS.kamino) || (market.lender === 'jupiter-lend' && market.programId !== MAINNET_PROGRAM_IDS.jupiterLend)) return { ok: false, reason: 'lender/program mismatch' };
    if (!enabledMints.has(market.collateralMint)) return { ok: false, reason: 'stock collateral is not registry-enabled' };
    if (market.debtMint !== SOLANA_USDC_MINT && market.debtMint !== 'native-usdc') return { ok: false, reason: 'market debt is not native USDC' };
    if (!Number.isSafeInteger(market.observedAtMs) || market.observedAtMs < 0) return { ok: false, reason: 'market discovery timestamp is invalid' };
    if (market.observedAtMs > nowMs + 5_000 || nowMs - market.observedAtMs > maxAgeMs) return { ok: false, reason: 'market/oracle discovery is stale' };
    if (!market.marketAddress || !market.reserveAddress || !market.vaultAddress || !market.oracleAddress || !market.idlSha256 || !market.bytecodeSha256 || !market.upgradeAuthority) return { ok: false, reason: 'market discovery is incomplete' };
    if (marketVerifier) {
      const manifestCheck = marketVerifier(market);
      if (!manifestCheck.ok) return { ok: false, reason: manifestCheck.reason ?? 'market does not match the signed deployment manifest' };
    }
  }
  return { ok: true };
}
