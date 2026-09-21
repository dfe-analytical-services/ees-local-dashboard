import { $ } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './services';

/**
 * Where the data screener's source lives and how its image gets built, shared
 * between the CLI (`start.ts`) and the dashboard's Docker manager so the two
 * can't drift apart on which checkout and build arguments the image comes
 * from.
 */

export const screenerRepositoryName = 'ees-screener-api';

// Cloned alongside the managed explore-education-statistics checkout, which is
// where docker-compose.yml's `build: context: ../ees-screener-api` points.
export const screenerLocalDir = path.resolve(
  projectRoot,
  '..',
  screenerRepositoryName,
);

export const screenerRepoUrl =
  'https://github.com/dfe-analytical-services/ees-screener-api';

/**
 * Makes sure the screener checkout exists where the Compose build context
 * points, cloning it if it's never been fetched. Unlike the CLI's
 * clone-or-pull, an existing checkout is left alone: this only runs when the
 * *image* is missing, and silently moving someone's checkout forward as a side
 * effect of a Start button would be a surprise.
 */
export async function ensureScreenerCheckout(): Promise<void> {
  if (fs.existsSync(screenerLocalDir)) {
    return;
  }

  await $`git clone ${screenerRepoUrl} ${screenerLocalDir}`;
}

export function getMondayDateStringForPriorWeek(
  numberOfWeeksPrior: number,
): string {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const isoDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek;

  const daysToSubtract = isoDayOfWeek + numberOfWeeksPrior * 7 - 1;

  const previousMonday = new Date(today);
  previousMonday.setDate(today.getDate() - daysToSubtract);
  return previousMonday.toISOString().split('T')[0];
}

/**
 * The CRAN snapshot the screener image should install its R packages from.
 *
 * Pulled from a repository snapshot 3 weeks old to better ensure that we're
 * grabbing dependencies that have pre-compiled binaries during local
 * development. The Screener API build pipeline will continue to pull from the
 * very latest CRAN repositories as build speed in the build pipeline is not as
 * crucial as it is locally.
 */
export function getCranSnapshotDate(): string {
  return getMondayDateStringForPriorWeek(3);
}
