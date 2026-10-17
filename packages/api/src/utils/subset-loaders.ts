import { type SubsetQuery } from "sonamu";

export function getSubsetLoaders(subsets: string[], subsetQueries: Record<string, SubsetQuery>) {
  const loaders: Record<string, SubsetQuery["loaders"]> = {};

  for (const subset of subsets) {
    loaders[subset] = subsetQueries[subset]?.loaders ?? [];
  }

  return loaders;
}
