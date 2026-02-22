import algosdk from "algosdk";

export const EXPLORER_BASE = "https://testnet.explorer.perawallet.app";

const ALGOD_SERVER   = "https://testnet-api.algonode.cloud";
const INDEXER_SERVER = "https://testnet-idx.algonode.cloud";

let _algod: algosdk.Algodv2 | null = null;
let _indexer: algosdk.Indexer | null = null;

export function getAlgod(): algosdk.Algodv2 {
  if (!_algod)
    _algod = new algosdk.Algodv2("", ALGOD_SERVER, 443);
  return _algod;
}

export function getIndexer(): algosdk.Indexer {
  if (!_indexer)
    _indexer = new algosdk.Indexer("", INDEXER_SERVER, 443);
  return _indexer;
}

export function shortenAddress(addr: string, n = 4): string {
  if (!addr) return "";
  return `${addr.slice(0, n)}...${addr.slice(-n)}`;
}

export function explorerAssetUrl(id: number): string {
  return `${EXPLORER_BASE}/asset/${id}`;
}

export function explorerTxUrl(txId: string): string {
  return `${EXPLORER_BASE}/tx/${txId}`;
}

function buildNote(type: string, props: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      standard: "arc69",
      description: `Eden Pods — ${type}`,
      external_url: "https://edenpods.earth",
      properties: { ...props, eden_type: type, eden_version: 1 },
    })
  );
}

function parseNote(note: unknown): Record<string, unknown> | null {
  try {
    let str: string;

    if (note instanceof Uint8Array) {
      // algosdk v3 indexer returns note as raw bytes
      str = new TextDecoder().decode(note);
    } else if (typeof note === "string") {
      // fallback: base64 string (older SDK behaviour)
      str = atob(note);
    } else {
      return null;
    }

    const obj = JSON.parse(str);
    if (obj?.standard === "arc69" && obj?.properties?.eden_type)
      return obj.properties as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export interface ThrowMetadata {
  podTypeId: string;
  podTypeName: string;
  podTypeIcon: string;
  throwDate: string;
  locationLabel: string;
  growthModelId: string;
  thrownBy: string;
  version: number;
}

export interface OnChainThrow {
  asaId: number;
  txId: string;
  throwDate: string;
  podTypeId: string;
  podTypeName: string;
  podTypeIcon: string;
  locationLabel: string;
  growthModelId: string;
  thrownBy: string;
  confirmedAt: string;
  explorerUrl: string;
}

export interface OnChainHarvest {
  txId: string;
  throwAsaId: number;
  plantId: string;
  quantityClass: "small" | "medium" | "large";
  harvestedAt: string;
  notes: string;
  confirmedAt: string;
}

export async function buildMintThrowTxns(params: {
  senderAddress: string;
  metadata: ThrowMetadata;
}): Promise<algosdk.Transaction[]> {
  if (!params.senderAddress) throw new Error("Wallet not connected");
  const sp = await getAlgod().getTransactionParams().do();
  const name = `Eden Throw ${params.metadata.podTypeIcon} ${params.metadata.podTypeName}`.slice(0, 32);
  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender: params.senderAddress,
    assetName: name,
    unitName: "THROW",
    total: 1n,
    decimals: 0,
    defaultFrozen: false,
    manager: params.senderAddress,
    reserve: params.senderAddress,
    assetURL: "https://edenpods.earth",
    note: buildNote("throw", params.metadata),
    suggestedParams: sp,
  });
  return [txn];
}

export async function buildHarvestTxn(
  senderAddress: string,
  props: {
    throwAsaId: number;
    plantId: string;
    quantityClass: string;
    harvestedAt: string;
    notes: string;
  }
): Promise<algosdk.Transaction> {
  if (!senderAddress) throw new Error("Wallet not connected");
  const sp = await getAlgod().getTransactionParams().do();
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: senderAddress,
    receiver: senderAddress,
    amount: 0n,
    note: buildNote("harvest", props),
    suggestedParams: sp,
  });
}

export async function signAndSendTxns(
  txns: algosdk.Transaction[],
  senderAddress: string
): Promise<{ txIds: string[]; assetId?: number }> {
  if (!senderAddress) throw new Error("Wallet not connected");
  if (typeof window === "undefined") throw new Error("Browser only");

  const { PeraWalletConnect } = await import("@perawallet/connect");
  const pera = new PeraWalletConnect({
    network: "testnet",
    shouldShowSignTxnToast: true,
  });
  try { await pera.reconnectSession(); } catch {}

  const algod = getAlgod();
  if (txns.length > 1) algosdk.assignGroupID(txns);

  const toSign = txns.map((txn) => ({ txn, signers: [senderAddress] }));
  const signed: Uint8Array[] = await pera.signTransaction([toSign]);

  const txIds: string[] = [];
  let assetId: number | undefined;

  for (const s of signed) {
    const { txid } = await algod.sendRawTransaction(s).do();
    txIds.push(txid);
    const result = await algosdk.waitForConfirmation(algod, txid, 4);
    if (result["asset-index"]) assetId = Number(result["asset-index"]);
  }

  return { txIds, assetId };
}

export async function fetchThrowsForAddress(
  address: string
): Promise<OnChainThrow[]> {
  const out: OnChainThrow[] = [];
  const indexer = getIndexer();

  console.log("[fetchThrows] fetching assets for", address);

  const resp = await indexer.searchForAssets().creator(address).do();
  const assets = (resp as { assets?: { index: number }[] }).assets ?? [];

  console.log("[fetchThrows] found", assets.length, "assets");

  for (const asset of assets) {
    try {
      const txResp = await indexer
        .searchForTransactions()
        .assetID(asset.index)
        .txType("acfg")
        .do();
      const txns =
        (txResp as { transactions?: Record<string, unknown>[] })
          .transactions ?? [];

      if (!txns.length) {
        console.log("[fetchThrows] no txns for asset", asset.index);
        continue;
      }

      // Try all txns, not just the latest — find one with valid note
      let found = false;
      for (const tx of [...txns].reverse()) {
        if (!tx.note) continue;
        const props = parseNote(tx.note as string);
        if (!props || props.eden_type !== "throw") continue;

        const rt = (tx["round-time"] as number) ?? 0;
        out.push({
          asaId: asset.index,
          txId: tx.id as string,
          throwDate:
            (props.throwDate as string) ??
            new Date(rt * 1000).toISOString(),
          podTypeId: (props.podTypeId as string) ?? "",
          podTypeName: (props.podTypeName as string) ?? "",
          podTypeIcon: (props.podTypeIcon as string) ?? "🌱",
          locationLabel: (props.locationLabel as string) ?? "",
          growthModelId:
            (props.growthModelId as string) ?? "temperate-herb",
          thrownBy: (props.thrownBy as string) ?? address,
          confirmedAt: new Date(rt * 1000).toISOString(),
          explorerUrl: explorerAssetUrl(asset.index),
        });
        found = true;
        break;
      }

if (!found) {
  // Decode note for debugging
  let notePreview = "none";
  try {
    if (txns[0]?.note instanceof Uint8Array) {
      notePreview = new TextDecoder().decode(txns[0].note as Uint8Array).slice(0, 120);
    } else if (typeof txns[0]?.note === "string") {
      notePreview = atob(txns[0].note as string).slice(0, 120);
    }
  } catch {}
  console.log("[fetchThrows] asset", asset.index, "no valid eden note. Preview:", notePreview);
}

  console.log("[fetchThrows] returning", out.length, "throws");

  return out.sort(
    (a, b) =>
      new Date(b.throwDate).getTime() - new Date(a.throwDate).getTime()
  );
}

export async function fetchHarvestsForAddress(
  address: string
): Promise<OnChainHarvest[]> {
  const out: OnChainHarvest[] = [];
  try {
    const indexer = getIndexer();
    const resp = await indexer
      .searchForTransactions()
      .address(address)
      .addressRole("sender")
      .txType("pay")
      .do();
    const txns =
      (resp as { transactions?: Record<string, unknown>[] }).transactions ??
      [];
    for (const txn of txns) {
      if (!txn.note) continue;
      const props = parseNote(txn.note as string);
      if (!props || props.eden_type !== "harvest") continue;
      const rt = (txn["round-time"] as number) ?? 0;
      out.push({
        txId: txn.id as string,
        throwAsaId: (props.throwAsaId as number) ?? 0,
        plantId: (props.plantId as string) ?? "",
        quantityClass:
          (props.quantityClass as "small" | "medium" | "large") ?? "small",
        harvestedAt:
          (props.harvestedAt as string) ??
          new Date(rt * 1000).toISOString(),
        notes: (props.notes as string) ?? "",
        confirmedAt: new Date(rt * 1000).toISOString(),
      });
    }
  } catch (e) {
    console.warn("fetchHarvests failed:", e);
  }
  return out.sort(
    (a, b) =>
      new Date(b.harvestedAt).getTime() - new Date(a.harvestedAt).getTime()
  );
}
