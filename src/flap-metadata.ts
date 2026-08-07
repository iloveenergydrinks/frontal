import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { getAddress, isAddress, type Address } from "viem";

import { NexusError } from "./errors.js";
import { normalizeHttpsUrl, normalizeMetadataText } from "./metadata.js";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_IMAGE_SIZE = 512;
const PROFILE_DESCRIPTION_MAX_CHARACTERS = 2_000;

export interface FlapMetadataUploadInput {
  creator: Address;
  description?: string;
  imagePath: string;
  telegram?: string;
  twitter?: string;
  website?: string;
}

export interface FlapMetadataUploadResult {
  gatewayImageUrl: string;
  imageCid: string;
  imageUri: string;
  metadataCid: string;
  metadataUri: string;
}

function detectPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => bytes[index] === byte);
}

function pngDimensions(bytes: Uint8Array): { height: number; width: number } | undefined {
  if (bytes.length < 24 || !detectPng(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (ihdr !== "IHDR") return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function bareIpfsCid(value: string, field: string): string {
  const bare = value.startsWith("ipfs://") ? value.slice("ipfs://".length) : value;
  if (!/^[a-zA-Z0-9]+$/u.test(bare)) {
    throw new NexusError("METADATA_UPLOAD_FAILED", `${field} is not a valid bare IPFS CID.`);
  }
  return bare;
}

export async function uploadFlapMetadata(input: FlapMetadataUploadInput): Promise<FlapMetadataUploadResult> {
  if (!isAddress(input.creator)) throw new NexusError("INVALID_ARGUMENT", "creator must be an EVM address.");
  const bytes = await readFile(input.imagePath).catch((cause: unknown) => {
    throw new NexusError("METADATA_UPLOAD_FAILED", `Unable to read image ${input.imagePath}.`, { cause });
  });
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
    throw new NexusError("INVALID_TOKEN_METADATA", "The image must be a non-empty PNG no larger than 10 MiB.");
  }
  if (!detectPng(bytes)) {
    throw new NexusError("INVALID_TOKEN_METADATA", "Version 0.1 accepts PNG profile images only.");
  }
  const dimensions = pngDimensions(bytes);
  if (dimensions?.width !== PROFILE_IMAGE_SIZE || dimensions.height !== PROFILE_IMAGE_SIZE) {
    throw new NexusError(
      "INVALID_TOKEN_METADATA",
      `The profile image must be exactly ${PROFILE_IMAGE_SIZE}x${PROFILE_IMAGE_SIZE} pixels.`,
    );
  }
  const description = normalizeMetadataText(input.description ?? "", "description", false);
  if ([...description].length > PROFILE_DESCRIPTION_MAX_CHARACTERS) {
    throw new NexusError(
      "INVALID_TOKEN_METADATA",
      `description exceeds ${PROFILE_DESCRIPTION_MAX_CHARACTERS} characters.`,
    );
  }
  const telegram = normalizeHttpsUrl(input.telegram, "telegram");
  const twitter = normalizeHttpsUrl(input.twitter, "twitter");
  const website = normalizeHttpsUrl(input.website, "website");
  const operations = {
    query: "mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }",
    variables: {
      file: null,
      meta: {
        buy: null,
        creator: getAddress(input.creator),
        description,
        sell: null,
        telegram: telegram === "" ? null : telegram,
        twitter: twitter === "" ? null : twitter,
        website: website === "" ? null : website,
      },
    },
  };
  const form = new FormData();
  form.append("operations", JSON.stringify(operations));
  form.append("map", JSON.stringify({ "0": ["variables.file"] }));
  form.append("0", new Blob([bytes], { type: "image/png" }), basename(input.imagePath));

  let response: Response;
  try {
    response = await fetch("https://funcs.flap.sh/api/upload", { body: form, method: "POST" });
  } catch (cause) {
    throw new NexusError("METADATA_UPLOAD_FAILED", "Flap metadata upload request failed.", { cause });
  }
  if (!response.ok) {
    throw new NexusError("METADATA_UPLOAD_FAILED", `Flap metadata upload returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { data?: { create?: string }; errors?: unknown };
  const metadataCidValue = payload.data?.create;
  if (typeof metadataCidValue !== "string" || metadataCidValue.length === 0) {
    throw new NexusError("METADATA_UPLOAD_FAILED", "Flap metadata upload did not return a metadata CID.");
  }
  const metadataCid = bareIpfsCid(metadataCidValue, "metadata CID");
  const gateway = `https://flap.mypinata.cloud/ipfs/${metadataCid}`;
  const metadataResponse = await fetch(gateway);
  if (!metadataResponse.ok) {
    throw new NexusError("METADATA_UPLOAD_FAILED", "Uploaded metadata could not be read back from the Flap gateway.");
  }
  const metadata = (await metadataResponse.json()) as { image?: unknown };
  if (typeof metadata.image !== "string" || metadata.image.length === 0) {
    throw new NexusError("METADATA_UPLOAD_FAILED", "Uploaded metadata does not contain an image CID.");
  }
  const imageCid = bareIpfsCid(metadata.image, "image CID");
  return {
    gatewayImageUrl: `https://flap.mypinata.cloud/ipfs/${imageCid}`,
    imageCid,
    imageUri: `ipfs://${imageCid}`,
    metadataCid,
    metadataUri: `ipfs://${metadataCid}`,
  };
}
