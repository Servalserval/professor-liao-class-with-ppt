import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRuntime } from "../src/build.js";
import { loadLiveConfig } from "../src/liveConfig.js";

const ROOT = new URL("../../../", import.meta.url).pathname;

const ENV = {
  EVM_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  SUI_ADDRESS: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  RPC_ETHEREUM: "https://eth.invalid",
  RPC_ARBITRUM: "https://arb.invalid",
  RPC_BASE: "https://base.invalid",
  RPC_PLASMA: "https://plasma.invalid",
  RPC_MANTLE: "https://mantle.invalid",
  SUI_GRPC: "https://sui-grpc.invalid",
  SUI_JSONRPC: "https://sui-rpc.invalid",
} as NodeJS.ProcessEnv;

describe("live runner wiring (offline smoke test of config/live.example.yaml)", () => {
  it("loads the example config and builds every component without touching the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-"));
    const src = readFileSync(join(ROOT, "config/live.example.yaml"), "utf8")
      .replace("state_dir: state/live", `state_dir: ${dir}`)
      .replace("router_config: config/live-router.yaml", `router_config: ${join(ROOT, "config/live-router.yaml")}`);
    const path = join(dir, "live.yaml");
    writeFileSync(path, src);
    const { raw, cfg, missingEnv } = loadLiveConfig(path, ENV);
    assert.deepEqual(missingEnv, []);
    const rt = await buildRuntime(cfg, raw, { positions: () => [], env: ENV, log: () => {} });

    assert.deepEqual(rt.sources.map((s) => s.id).sort(), ["aave-v3:ethereum", "aave-v3:mantle", "aave-v3:plasma"]);
    assert.deepEqual(Object.keys(rt.executors).sort(), ["aave-v3:ethereum", "aave-v3:mantle", "aave-v3:plasma"]);
    assert.deepEqual(Object.keys(rt.bridges).sort(), ["cctp_v2_standard", "swap", "usdt0_oft"]);
    assert.equal(rt.canSign.evm, false, "no key in env: read-only");
    // every enabled route endpoint is an idle bucket
    const keys = rt.buckets.keys();
    for (const k of ["arbitrum:USDC", "arbitrum:USDT0", "plasma:USDT0", "plasma:USDe", "ethereum:USDe", "sui:USDC", "base:USDC", "mantle:USDe"]) assert.ok(keys.includes(k), k);
    // assets resolved from the address book / USDT0 table
    assert.match(rt.assets.plasma!.USDe!.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(rt.assets.arbitrum!.USDT0!.decimals, 6);
    assert.equal(rt.routerCfg.caps.max_position_usd, 2000, "canary clamps the router cap");
    assert.equal(rt.routerCfg.xchain.enabled, true);
    assert.ok(rt.routerCfg.xchain.routes.length > 10);
    assert.equal(rt.hash.length, 64);
  });
});
