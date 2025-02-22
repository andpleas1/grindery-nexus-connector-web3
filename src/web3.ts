import Web3 from "web3";
import { ConnectorInput, ConnectorOutput, TriggerBase } from "./connectorCommon";
import { AbiItem } from "web3-utils";
import { TransactionConfig, Log } from "web3-core";

const CHAIN_MAPPING = {
  "eip155:1": "eth",
  "eip155:42161": "arbitrum",
  "eip155:100": "gnosis",
  "eip155:137": "polygon",
  "eip155:42220": "celo",
  "eip155:43114": "avalanche",
  "eip155:56": "bsc",
  "eip155:250": "fantom",
  "eip155:245022934": "solana",

  "eip155:80001": "wss://rpc-mumbai.matic.today/", // Polygon Mumbai testnet
};

function getWeb3(chain = "eth") {
  const url = CHAIN_MAPPING[chain]?.includes("://")
    ? CHAIN_MAPPING[chain]
    : `wss://rpc.ankr.com/${CHAIN_MAPPING[chain] || chain}/ws/${process.env.ANKR_KEY}`;
  const provider = new Web3.providers.WebsocketProvider(url, {
    reconnect: {
      auto: true,
      delay: 1000,
      onTimeout: true,
    },
  });
  const web3 = new Web3(provider);
  return {
    web3,
    close: () => {
      web3.setProvider(null);
      provider.reset();
      provider.disconnect();
    },
  };
}
function isSameAddress(a, b) {
  if (!a || !b) {
    return false;
  }
  if (/^0x/.test(a) && /^0x/.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
function parseEventDeclaration(eventDeclaration: string): AbiItem {
  const m = /^\s*(event +)?([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*;?\s*$/.exec(eventDeclaration);
  if (!m) {
    throw new Error("Invalid event declaration");
  }
  const name = m[2];
  const inputs = m[3].split(",").map((p) => {
    const parts = p.trim().split(/\s+/);
    if (parts.length !== 2 && parts.length !== 3) {
      throw new Error("Invalid event declaration: Invalid parameter " + p);
    }
    if (parts.length === 3 && parts[1] !== "indexed") {
      throw new Error("Invalid event declaration: Invalid parameter " + p);
    }
    return {
      indexed: parts.length === 3,
      type: parts[0],
      name: parts[parts.length - 1],
    };
  });
  return {
    name,
    inputs,
    type: "event",
    anonymous: false,
  };
}
function parseFunctionDeclaration(functionDeclaration: string): AbiItem {
  const m = /^\s*(function +)?([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*(.*)$/.exec(functionDeclaration);
  if (!m) {
    throw new Error("Invalid function declaration");
  }
  const name = m[2];
  const inputs = m[3].split(",").map((p) => {
    const parts = p.trim().split(/\s+/);
    if (parts.length < 2) {
      throw new Error("Invalid function declaration: Invalid parameter " + p);
    }
    return {
      type: parts[0],
      name: parts[parts.length - 1],
    };
  });
  const suffixes = m[4].trim().split(/\s+/);
  return {
    name,
    inputs,
    constant: suffixes.includes("view"),
    payable: suffixes.includes("payable"),
    stateMutability: suffixes.includes("pure")
      ? "pure"
      : suffixes.includes("view")
      ? "view"
      : suffixes.includes("payable")
      ? "payable"
      : "nonpayable",
    type: "function",
  };
}

export class NewTransactionTrigger extends TriggerBase<{ chain: string; from?: string; to?: string }> {
  async main() {
    const { web3, close } = getWeb3(this.fields.chain);
    let lastBlock = -1;
    const subscription = web3.eth
      .subscribe("newBlockHeaders")
      .on("data", async (block) => {
        if (!block.number) {
          return;
        }
        if (lastBlock <= 0) {
          lastBlock = block.number;
          return;
        }
        while (lastBlock < block.number - 2) {
          lastBlock++;
          const blockWithTransactions = await web3.eth.getBlock(lastBlock, true);
          if (!blockWithTransactions.transactions) {
            console.log("No transactions in block", blockWithTransactions.number, blockWithTransactions);
            return;
          }
          for (const transaction of blockWithTransactions.transactions) {
            if (this.fields.from && !isSameAddress(transaction.from, this.fields.from)) {
              continue;
            }
            if (this.fields.to && !isSameAddress(transaction.to, this.fields.to)) {
              continue;
            }
            await this.sendNotification(transaction);
          }
        }
      })
      .on("error", (error) => {
        console.error(error);
      });
    await this.waitForStop();
    await subscription.unsubscribe();
    close();
  }
}
export class NewEventTrigger extends TriggerBase<{
  chain: string;
  contractAddress: string;
  eventDeclaration: string;
  parameterFilters: { [key: string]: unknown };
}> {
  async main() {
    const { web3, close } = getWeb3(this.fields.chain);
    const eventInfo = parseEventDeclaration(this.fields.eventDeclaration);
    const topics = [web3.eth.abi.encodeEventSignature(eventInfo)] as (string | null)[];
    const inputs = eventInfo.inputs || [];
    for (const input of inputs) {
      if (input.indexed) {
        const value = this.fields.parameterFilters[input.name];
        topics.push(
          input.name in this.fields.parameterFilters ? web3.eth.abi.encodeParameter(input.type, value) : null
        );
      }
    }
    let pendingLogs = [] as Log[];
    const subscription = web3.eth
      .subscribe("logs", {
        address: this.fields.contractAddress,
        topics,
      })
      .on("data", async (logEntry) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((logEntry as any).removed) {
          pendingLogs = pendingLogs.filter((x) => x.blockHash !== logEntry.blockHash);
          return;
        }
        pendingLogs.push(logEntry);
      })
      .on("error", (error) => {
        console.error(error);
      });
    const subscriptionBlock = web3.eth
      .subscribe("newBlockHeaders")
      .on("data", async (block) => {
        if (!block.number) {
          return;
        }
        const logs = pendingLogs;
        pendingLogs = [];
        const newPendingLogs = [] as Log[];
        for (const logEntry of logs) {
          if (logEntry.blockNumber > block.number - 2) {
            newPendingLogs.push(logEntry);
            continue;
          }
          const decoded = web3.eth.abi.decodeLog(inputs, logEntry.data, logEntry.topics.slice(1));
          const event = {} as { [key: string]: unknown };
          for (const input of inputs) {
            const name = input.name;
            if (!(name in this.fields.parameterFilters)) {
              continue;
            }
            if (
              web3.eth.abi.encodeParameter(input.type, decoded[name]) !==
              web3.eth.abi.encodeParameter(input.type, this.fields.parameterFilters[name])
            ) {
              return;
            }
            event[name] = decoded[name];
          }
          await this.sendNotification({
            _rawEvent: logEntry,
            ...event,
          });
        }
        pendingLogs = pendingLogs.concat(newPendingLogs);
      })
      .on("error", (error) => {
        console.error(error);
      });
    await this.waitForStop();
    await subscription.unsubscribe();
    await subscriptionBlock.unsubscribe();
    close();
  }
}

export async function callSmartContract(
  input: ConnectorInput<{
    chain: string;
    contractAddress: string;
    functionDeclaration: string;
    parameters: { [key: string]: unknown };
    maxFeePerGas?: string | number;
    maxPriorityFeePerGas?: string | number;
    gasLimit?: string | number;
    dryRun?: boolean;
  }>
): Promise<ConnectorOutput> {
  const { web3, close } = getWeb3(input.fields.chain);
  try {
    web3.eth.transactionConfirmationBlocks = 1;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const account = web3.eth.accounts.privateKeyToAccount(process.env.WEB3_PRIVATE_KEY!);
    web3.eth.accounts.wallet.add(account);
    web3.eth.defaultAccount = account.address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paramArray = [] as any[];
    const functionInfo = parseFunctionDeclaration(input.fields.functionDeclaration);
    const inputs = functionInfo.inputs || [];
    for (const i of inputs) {
      if (!(i.name in input.fields.parameters)) {
        throw new Error("Missing parameter " + i.name);
      }
      paramArray.push(input.fields.parameters[i.name]);
    }
    const callData = web3.eth.abi.encodeFunctionCall(functionInfo, paramArray);
    const txConfig: TransactionConfig = {
      from: account.address,
      to: input.fields.contractAddress,
      data: callData,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nonce: web3.utils.toHex(await web3.eth.getTransactionCount(account.address)) as any,
    };
    let result: unknown;
    for (const key of ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"]) {
      if (key in input.fields && typeof input.fields[key] === "string") {
        input.fields[key] = web3.utils.toWei(input.fields[key], "ether");
      }
    }
    const gas = await web3.eth.estimateGas(txConfig);
    txConfig.gas = Math.ceil(gas * 1.1 + 1000);
    const block = await web3.eth.getBlock("pending");
    const baseFee = Number(block.baseFeePerGas);
    const minFee = baseFee + Number(web3.utils.toWei("30", "gwei"));
    const maxTip = input.fields.maxPriorityFeePerGas || web3.utils.toWei("75", "gwei");
    const maxFee = input.fields.gasLimit
      ? Math.floor(Number(input.fields.gasLimit) / txConfig.gas)
      : baseFee + Number(maxTip);
    if (maxFee < minFee) {
      throw new Error(
        `Gas limit of ${web3.utils.fromWei(
          String(input.fields.gasLimit),
          "ether"
        )} is too low, need at least ${web3.utils.fromWei(String(minFee * txConfig.gas), "ether")}`
      );
    }
    txConfig.maxFeePerGas = maxFee;
    txConfig.maxPriorityFeePerGas = Math.min(Number(maxTip), maxFee - baseFee - 1);
    if (functionInfo.constant || functionInfo.stateMutability === "pure" || input.fields.dryRun) {
      result = {
        returnValue: await web3.eth.call(txConfig),
        estimatedGas: gas,
        minFee,
      };
    } else {
      result = await web3.eth.sendTransaction(txConfig);
    }

    return {
      key: input.key,
      sessionId: input.sessionId,
      payload: result,
    };
  } finally {
    close();
  }
}
