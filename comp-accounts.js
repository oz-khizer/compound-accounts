// Fetch top COMP holders via Dune Sim API, filter ≥25K COMP, detect account type
// Handles rate limits with retry/backoff
// Requires Node.js v14+, ethers v6, node-fetch v2
// Ensure your package.json includes: { "type": "module" }

import fetch from 'node-fetch';
import fs from 'fs';
import { JsonRpcProvider, FallbackProvider, Contract, parseUnits, formatUnits } from 'ethers';

// Env vars:
// SIM_API_KEY   - your Dune Sim API key
// INFURA_URL    - your Infura endpoint (optional)


const SIM_API_KEY = process.env.SIM_API_KEY;
if (!SIM_API_KEY) throw new Error('Missing SIM_API_KEY');

// Configure Ethereum provider(s)
const providers = [];
if (process.env.INFURA_URL) providers.push(new JsonRpcProvider(process.env.INFURA_URL));
if (process.env.ALCHEMY_URL) providers.push(new JsonRpcProvider(process.env.ALCHEMY_URL));
let provider;
if (providers.length > 1) provider = new FallbackProvider(providers);
else if (providers.length === 1) provider = providers[0];
else throw new Error('Set INFURA_URL or ALCHEMY_URL');

// ERC20 minimal ABI for COMP
const COMP_ADDRESS = '0xc00e94cb662c3520282e6f5717214004a7f26888';
const ERC20_ABI = ['function decimals() view returns (uint8)'];
const compContract = new Contract(COMP_ADDRESS, ERC20_ABI, provider);

// Sim API token-holders endpoint parameters
const CHAIN_ID = 1;
const PAGE_LIMIT = 500;
// Retry/backoff settings for Sim API
const SIM_MAX_ATTEMPTS = 3;
const SIM_BASE_DELAY = 1000; // 1 second

// Helper to sleep
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Fetch token holders page with retry/backoff on rate limit or network errors
async function fetchTokenHolders(offset) {
  let attempt = 0;
  let lastErr;
  while (attempt < SIM_MAX_ATTEMPTS) {
    try {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (offset) params.set('offset', offset);
      const url = `https://api.sim.dune.com/v1/evm/token-holders/${CHAIN_ID}/${COMP_ADDRESS}?${params}`;
      const res = await fetch(url, { headers: { 'X-Sim-Api-Key': SIM_API_KEY } });
      if (res.status === 429) {
        throw new Error('429 Too Many Requests');
      }
      if (!res.ok) {
        throw new Error(`Sim API error: ${res.status} ${res.statusText}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      attempt++;
      const delay = SIM_BASE_DELAY * Math.pow(2, attempt);
      console.warn(`Sim API attempt ${attempt}/${SIM_MAX_ATTEMPTS} failed: ${err.message}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`Failed fetchTokenHolders after ${SIM_MAX_ATTEMPTS} attempts: ${lastErr.message}`);
}

// Retrieve all holders ≥ threshold via paginated Sim API
async function getHoldersAboveThreshold(thresholdBn) {
  let all = [];
  let offset;
  do {
    const { holders, next_offset } = await fetchTokenHolders(offset);
    all = all.concat(
      holders
        .filter(h => BigInt(h.balance) >= thresholdBn)
        .map(h => ({ address: h.wallet_address, balanceBn: BigInt(h.balance) }))
    );
    offset = next_offset;
    // small pause between pages
    await sleep(500);
  } while (offset);
  return all;
}

// Gnosis Safe minimal ABI to detect multisig
const SAFE_ABI = ['function getOwners() view returns (address[])'];

async function classifyAddress(address) {
  const code = await provider.getCode(address);
  if (code === '0x') return 'EOA';
  try {
    const safe = new Contract(address, SAFE_ABI, provider);
    const owners = await safe.getOwners();
    return `Gnosis Safe (${owners.length} owners)`;
  } catch {
    return 'Contract';
  }
}

// Main flow
async function main() {
  const dec = await compContract.decimals();
  const thresholdBn = parseUnits('25000', dec);
  console.log('Fetching COMP holders ≥ 25,000...');
  const holders = await getHoldersAboveThreshold(thresholdBn);

  const results = [];
  for (const { address, balanceBn } of holders) {
    const type = await classifyAddress(address);
    results.push({ address, comp: formatUnits(balanceBn, dec), type });
    await sleep(200);
  }

  console.table(results);
  fs.writeFileSync('comp_holders_with_type.json', JSON.stringify(results, null, 2));
  console.log('Done. Output in comp_holders_with_type.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
