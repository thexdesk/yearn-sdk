import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import fetch from "cross-fetch";

import { CachedFetcher } from "../cache";
import { ChainId } from "../chain";
import { ServiceInterface } from "../common";
import { Address, StrategiesMetadata, StrategyMetadata } from "../types";
import { VaultStrategiesMetadata } from "../types/strategy";

interface VaultData {
  address: Address;
  token: {
    symbol: string;
  };
  strategies: {
    name: string;
    address: Address;
  }[];
}

const VaultAbi = [
  "function strategies(address) view returns (uint256 performanceFee, uint256 activation, uint256 debtRatio, uint256 rateLimit, uint256 lastReport, uint256 totalDebt, uint256 totalGain, uint256 totalLoss)"
];

export class StrategyInterface<T extends ChainId> extends ServiceInterface<T> {
  private cachedFetcher = new CachedFetcher<VaultStrategiesMetadata[]>(
    "strategies/metadata/get",
    this.ctx,
    this.chainId
  );

  async vaultsStrategiesMetadata(vaultAddresses: Address[]): Promise<VaultStrategiesMetadata[]> {
    const cached = await this.cachedFetcher.fetch();
    if (cached) {
      return cached;
    }

    const vaultsData = await this.fetchVaultsData();

    const strategiesMetadata = await this.yearn.services.meta.strategies();

    let vaultsStrategiesMetadataPromises: Promise<VaultStrategiesMetadata | undefined>[];
    if (vaultAddresses) {
      vaultsStrategiesMetadataPromises = vaultAddresses.map(async vaultAddress => {
        const vaultDatum = vaultsData.find(datum => datum.address === vaultAddress);
        if (!vaultDatum) {
          return undefined;
        }
        return this.fetchVaultStrategiesMetadata(vaultDatum, strategiesMetadata);
      });
    } else {
      vaultsStrategiesMetadataPromises = vaultsData.map(async vaultDatum => {
        return this.fetchVaultStrategiesMetadata(vaultDatum, strategiesMetadata);
      });
    }

    return Promise.all(vaultsStrategiesMetadataPromises).then(vaultsStrategyData => {
      return vaultsStrategyData.flatMap(data => (data ? [data] : []));
    });
  }

  private async fetchVaultStrategiesMetadata(
    vaultDatum: VaultData,
    strategiesMetadata: StrategiesMetadata[]
  ): Promise<VaultStrategiesMetadata | undefined> {
    const provider = this.ctx.provider.read;
    const vaultContract = new Contract(vaultDatum.address, VaultAbi, provider);

    if (vaultDatum.strategies.length === 0) {
      return undefined;
    }

    let metadata: StrategyMetadata[] = await Promise.all(
      vaultDatum.strategies.map(async strategy => {
        let debtRatio: BigNumber;

        try {
          const struct = await vaultContract.strategies(strategy.address);
          debtRatio = struct.debtRatio as BigNumber;
        } catch (error) {
          return undefined;
        }

        if (debtRatio.lte(BigNumber.from("0"))) {
          return undefined;
        }

        const metadata = strategiesMetadata.find(strategyMetadata => {
          return strategyMetadata.addresses.includes(strategy.address);
        });

        const description = metadata?.description.replace(/{{token}}/g, vaultDatum.token.symbol);

        return {
          address: strategy.address,
          name: metadata?.name || strategy.name,
          description: description || "I don't have a description for this strategy yet",
          debtRatio: debtRatio.toString()
        };
      })
    ).then(metadatas => metadatas.flatMap(metadata => (metadata ? [metadata] : [])));

    if (metadata.length === 0) {
      return undefined;
    }

    metadata.sort((lhs, rhs) => parseInt(rhs.debtRatio) - parseInt(lhs.debtRatio));

    const result: VaultStrategiesMetadata = {
      vaultAddress: vaultDatum.address,
      strategiesMetadata: metadata
    };

    return result;
  }

  private async fetchVaultsData(): Promise<VaultData[]> {
    return fetch("https://d28fcsszptni1s.cloudfront.net/v1/chains/1/vaults/all").then(res => res.json());
  }
}
