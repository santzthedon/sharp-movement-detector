import { PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

export type NetworkName = "mainnet" | "devnet";

export const NETWORK: NetworkName =
  (process.env.NETWORK as NetworkName) || "devnet";

// These values are copied verbatim from TxLINE's Quickstart / World Cup Free
// Tier docs (https://txline-docs.txodds.com/documentation/quickstart).
// Do not edit unless TxODDS changes them - check the docs first if anything
// here starts returning errors.
export const CONFIG = {
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    guestAuthUrl: "https://txline.txodds.com/auth/guest/start",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlTokenMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    // Free World Cup / Int'l Friendlies tiers on mainnet
    freeServiceLevels: { delayed60s: 1, realTime: 12 },
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    apiOrigin: "https://txline-dev.txodds.com",
    guestAuthUrl: "https://txline-dev.txodds.com/auth/guest/start",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlTokenMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    // Docs note devnet's pricing matrix is authoritative and may differ from
    // this - level 1 currently reports samplingIntervalSec = 0. Confirm
    // on-chain before relying on this if something looks off.
    freeServiceLevels: { delayed60s: 1, realTime: 1 },
  },
} as const;

export const NET = CONFIG[NETWORK];
export const API_BASE = `${NET.apiOrigin}/api`;

export const WALLET_PATH = process.env.WALLET_PATH || "./wallet-devnet.json";
