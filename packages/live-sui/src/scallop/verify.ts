/**
 * On-chain verification of everything the Scallop adapter trusts from the
 * SDK's API-fetched address book (rule 6 of the agent brief): the core shared
 * objects exist and have the expected Move types, the configured coin types
 * and decimals match Scallop's registry AND the on-chain coin metadata, the
 * pair is allowed (collateral / borrowing whitelists, not deprecated, not the
 * same asset), the debt asset has a flash-loan fee entry, and pinned
 * obligations are owned by the wallet.
 */
import type { AssetRef } from "@incentive-router/live-common";
import { normalizeStructTag, type SuiEnv } from "../common.js";
import type { ScallopSdkLike } from "./sdk.js";

export interface ScallopVerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ScallopVerifyReport {
  ok: boolean;
  checks: ScallopVerifyCheck[];
}

interface PairLike {
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
}

const normType = (t: string) => normalizeStructTag(t.startsWith("0x") ? t : `0x${t}`);
const sameAddr = (a: string, b: string) => normType(`${a}::m::T`) === normType(`${b}::m::T`);

/** Core objects (address-book path -> expected `<module>::<struct>` of the object's type). */
const CORE_OBJECTS = [
  ["core.market", "market::Market"],
  ["core.version", "version::Version"],
  ["core.coinDecimalsRegistry", "coin_decimals_registry::CoinDecimalsRegistry"],
  ["core.oracles.xOracle", "x_oracle::XOracle"],
  ["core.obligationAccessStore", "obligation_access::ObligationAccessStore"],
  ["borrowIncentive.config", ""],
  ["borrowIncentive.incentivePools", ""],
  ["borrowIncentive.incentiveAccounts", ""],
] as const;

export async function verifyScallopConfig(
  env: SuiEnv,
  sdk: ScallopSdkLike,
  pairs: PairLike[],
  opts: { obligationIds?: Record<string, string | undefined> } = {}
): Promise<ScallopVerifyReport> {
  const checks: ScallopVerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  const c = sdk.constants;
  const wl = c.whitelist;

  // 1) address book completeness
  const paths = ["core.packages.protocol.id", ...CORE_OBJECTS.map(([p]) => p)] as const;
  const resolved: Record<string, string | undefined> = {};
  for (const path of paths) {
    const v = c.get(path);
    resolved[path] = v || undefined;
    add(`address:${path}`, !!v, v || "missing in Scallop address book");
  }

  // 2) the objects exist on-chain with the expected types
  const ids = CORE_OBJECTS.map(([p]) => resolved[p]).filter((x): x is string => !!x);
  const protocolPkg = c.protocolObjectId;
  try {
    const { objects } = await env.grpc.core.getObjects({ objectIds: [resolved["core.packages.protocol.id"] ?? protocolPkg, ...ids] });
    const [pkg, ...rest] = objects;
    add("onchain:core.packages.protocol.id", !!pkg && !(pkg instanceof Error), pkg instanceof Error ? pkg.message : undefined);
    let i = 0;
    for (const [path, suffix] of CORE_OBJECTS) {
      if (!resolved[path]) continue;
      const o = rest[i++];
      if (!o || o instanceof Error) {
        add(`onchain:${path}`, false, o instanceof Error ? o.message : "not found");
        continue;
      }
      const ok = suffix === "" || o.type.endsWith(`::${suffix}`);
      // the market lives in the ORIGINAL protocol package (type origin), which is what protocolObjectId names
      const pkgOk = path !== "core.market" || normType(o.type) === normType(`${protocolPkg}::market::Market`);
      add(`onchain:${path}`, ok && pkgOk, o.type);
    }
  } catch (e) {
    add("onchain:objects", false, e instanceof Error ? e.message : String(e));
  }

  // 3) pairs
  const flashNames = new Set<string>();
  for (const p of pairs) {
    const tag = `pair:${p.pairId}`;
    const ct = normType(p.collateral.address);
    const dt = normType(p.debt.address);
    add(`${tag}:distinct_assets`, ct !== dt, ct === dt ? "Scallop forbids the same coin as collateral and debt in one obligation" : undefined);
    for (const [role, a, type] of [["collateral", p.collateral, ct], ["debt", p.debt, dt]] as const) {
      const name = sdk.utils.parseCoinNameFromType(type);
      const known = c.coinTypes[name];
      add(`${tag}:${role}:coin_type`, !!known && normType(known) === type, `${name} -> ${known ?? "unknown"}`);
      const dec = c.coinDecimals[name];
      add(`${tag}:${role}:decimals_registry`, dec === a.decimals, `config ${a.decimals}, scallop ${dec}`);
      try {
        const md = await env.grpc.core.getCoinMetadata({ coinType: type });
        add(`${tag}:${role}:decimals_onchain`, md.coinMetadata?.decimals === a.decimals, `on-chain ${md.coinMetadata?.decimals ?? "none"}`);
      } catch (e) {
        add(`${tag}:${role}:decimals_onchain`, false, e instanceof Error ? e.message : String(e));
      }
      add(`${tag}:${role}:not_deprecated`, !wl.deprecated.has(name), wl.deprecated.has(name) ? `${name} is deprecated` : undefined);
      if (role === "collateral") {
        add(`${tag}:collateral_whitelisted`, wl.collateral.has(name), name);
        // Informational: would Scallop accept this asset's sCoin as collateral (it earns supply APR)? The adapter does not use it.
        const s = sdk.utils.parseSCoinName(name);
        add(`${tag}:scoin_collateral_info`, true, s && wl.collateral.has(s) ? `${s} IS whitelisted as collateral (unused by this adapter)` : `${s ?? "no sCoin"} not accepted as collateral`);
      } else {
        add(`${tag}:debt_borrowable`, wl.borrowing.has(name), name);
        flashNames.add(name);
      }
    }
  }
  try {
    const fees = await sdk.query.getFlashLoanFees([...flashNames]);
    for (const n of flashNames) add(`flashloan_fee:${n}`, typeof fees[n] === "number" && fees[n]! >= 0 && fees[n]! < 0.01, `${fees[n]}`);
  } catch (e) {
    add("flashloan_fees", false, e instanceof Error ? e.message : String(e));
  }

  // 4) pinned obligations are ours
  const pinned = Object.entries(opts.obligationIds ?? {}).filter((e): e is [string, string] => !!e[1]);
  if (pinned.length) {
    try {
      const owned = await sdk.query.getObligations(env.address);
      for (const [pairId, id] of pinned) {
        const o = owned.find((x) => sameAddr(x.id, id));
        add(`obligation:${pairId}`, !!o, o ? `key ${o.keyId}${o.locked ? " (staked)" : ""}` : `${id} not owned by ${env.address}`);
      }
    } catch (e) {
      add("obligations", false, e instanceof Error ? e.message : String(e));
    }
  }

  return { ok: checks.every((x) => x.ok), checks };
}
