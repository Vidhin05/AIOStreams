import { Addon, ParsedStream, UserData } from '../db/schemas';
import { constants, createLogger, getTimeTakenSincePoint } from '../utils';
import { Wrapper } from '../wrapper';
import { GroupConditionEvaluator } from '../parser/streamExpression';
import { getAddonName } from '../utils/general';
import StreamFilter from './filterer';
import StreamPrecompute from './precomputer';
import StreamDeduplicator from './deduplicator';

const logger = createLogger('fetcher');

class StreamFetcher {
  private userData: UserData;
  private filter: StreamFilter;
  private precompute: StreamPrecompute;
  private deduplicate: StreamDeduplicator;
  constructor(userData: UserData) {
    this.userData = userData;
    this.filter = new StreamFilter(userData);
    this.precompute = new StreamPrecompute(userData);
    this.deduplicate = new StreamDeduplicator(userData);
  }

  public async fetch(
    addons: Addon[],
    type: string,
    id: string
  ): Promise<{
    streams: ParsedStream[];
    errors: {
      title: string;
      description: string;
    }[];
    statistics: {
      title: string;
      description: string;
    }[];
  }> {
    const allErrors: {
      title: string;
      description: string;
    }[] = [];
    const allStatisticStreams: {
      title: string;
      description: string;
    }[] = [];
    let allStreams: ParsedStream[] = [];
    const start = Date.now();

    // Helper function to fetch streams from an addon and log summary
    const fetchFromAddon = async (addon: Addon) => {
      let summaryMsg = '';
      const start = Date.now();

      try {
        const streams = await new Wrapper(addon).getStreams(type, id);
        const errorStreams = streams.filter(
          (s) => s.type === constants.ERROR_STREAM_TYPE
        );
        const addonErrors = errorStreams.map((s) => ({
          title: `[❌] ${s.error?.title || getAddonName(addon)}`,
          description: s.error?.description || 'Unknown error',
        }));

        if (errorStreams.length > 0) {
          logger.error(
            `Found ${errorStreams.length} error streams from ${getAddonName(addon)}`,
            {
              errorStreams: errorStreams.map((s) => s.error?.title),
            }
          );
        }

        summaryMsg = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ${errorStreams.length > 0 ? '🟠' : '🟢'} [${getAddonName(addon)}] Scrape Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✔ Status      : ${errorStreams.length > 0 ? 'PARTIAL SUCCESS' : 'SUCCESS'}
  📦 Streams    : ${streams.length}
  📋 Details    : ${
    errorStreams.length > 0
      ? `Fetched streams with errors:\n${errorStreams.map((s) => `    • ${s.error?.title || 'Unknown error'}: ${s.error?.description || 'No description'}`).join('\n')}`
      : 'Successfully fetched streams.'
  }
  ⏱️ Time       : ${getTimeTakenSincePoint(start)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        let statisticStream = {
          title: `${errorStreams.length > 0 ? '🟠' : '🟢'} [${getAddonName(addon)}] Scrape Summary`,
          description: `✔ Status      : ${errorStreams.length > 0 ? 'PARTIAL SUCCESS' : 'SUCCESS'}
📦 Streams    : ${streams.length}
📋 Details    : ${
            errorStreams.length > 0
              ? `Fetched streams with errors:\n${errorStreams.map((s) => `    • ${s.error?.title || 'Unknown error'}: ${s.error?.description || 'No description'}`).join('\n')}`
              : 'Successfully fetched streams.'
          }
⏱️ Time       : ${getTimeTakenSincePoint(start)}
`,
        };

        return {
          success: true as const,
          streams: streams.filter(
            (s) => s.type !== constants.ERROR_STREAM_TYPE
          ),
          errors: addonErrors,
          statistics: statisticStream,
          timeTaken: Date.now() - start,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const addonErrors = {
          title: `[❌] ${getAddonName(addon)}`,
          description: errMsg,
        };
        summaryMsg = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🔴 [${getAddonName(addon)}] Scrape Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✖ Status      : FAILED
  🚫 Error      : ${errMsg}
  ⏱️ Time       : ${getTimeTakenSincePoint(start)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return {
          success: false as const,
          errors: [addonErrors],
          statistics: [],
          timeTaken: 0,
          streams: [],
        };
      } finally {
        logger.info(summaryMsg);
      }
    };

    // Helper function to fetch from a group of addons and track time
    const fetchFromGroup = async (addons: Addon[]) => {
      const groupStart = Date.now();
      const results = await Promise.all(addons.map(fetchFromAddon));

      const groupStreams = results.flatMap((r) => r.streams);
      const groupErrors = results.flatMap((r) => r.errors);
      const groupStatistics = results.flatMap((r) => r.statistics);

      const filteredStreams = await this.deduplicate.deduplicate(
        await this.filter.filter(groupStreams, type, id)
      );
      await this.precompute.precompute(filteredStreams);

      logger.info(
        `Group processing finished. Filtered to ${filteredStreams.length} streams in ${getTimeTakenSincePoint(groupStart)}`
      );
      return {
        totalTime: Date.now() - groupStart,
        streams: filteredStreams,
        statistics: groupStatistics,
        errors: groupErrors,
      };
    };

    // If groups are configured, handle group-based fetching
    if (
      this.userData.groups &&
      this.userData.groups.length > 0 &&
      this.userData.disableGroups !== true
    ) {
      // add addons that are not assigned to any group to the first group
      const unassignedAddons = addons.filter(
        (addon) =>
          !this.userData.groups!.some((group) =>
            group.addons.includes(addon.preset.id)
          )
      );
      if (unassignedAddons.length > 0) {
        this.userData.groups[0].addons.push(
          ...unassignedAddons.map((addon) => addon.preset.id)
        );
      }
      const groupPromises = this.userData.groups.map((group) => {
        const groupAddons = addons.filter(
          (addon) => addon.preset.id && group.addons.includes(addon.preset.id)
        );
        logger.info(
          `Queueing fetch for group with ${groupAddons.length} addons.`
        );
        return fetchFromGroup(groupAddons);
      });

      let totalTimeTaken = 0;
      let previousGroupStreams: ParsedStream[] = [];
      let previousGroupTimeTaken = 0;

      for (let i = 0; i < groupPromises.length; i++) {
        const groupResult = await groupPromises[i];
        const group = this.userData.groups[i];

        if (i === 0) {
          allStreams.push(...groupResult.streams);
          allErrors.push(...groupResult.errors);
          allStatisticStreams.push(...groupResult.statistics);
          totalTimeTaken = groupResult.totalTime;
          previousGroupStreams = groupResult.streams;
          previousGroupTimeTaken = groupResult.totalTime;

          // After the first group, check the condition for the second group
          if (groupPromises.length > 1) {
            const nextGroup = this.userData.groups[1];
            if (!nextGroup.condition || !nextGroup.addons.length) continue;

            const evaluator = new GroupConditionEvaluator(
              previousGroupStreams,
              allStreams,
              previousGroupTimeTaken,
              totalTimeTaken,
              type
            );
            const shouldFetchNext = await evaluator.evaluate(
              nextGroup.condition
            );

            if (!shouldFetchNext) {
              logger.info(
                `Condition not met for group 2 based on group 1 results. Halting further processing.`
              );
              break; // Exit the loop, returning only group 1 streams
            }
          }
        } else {
          // For groups other than the first, check their condition before processing
          if (!group.condition || !group.addons.length) continue;

          const evaluator = new GroupConditionEvaluator(
            previousGroupStreams,
            allStreams,
            previousGroupTimeTaken,
            totalTimeTaken,
            type
          );
          const shouldFetch = await evaluator.evaluate(group.condition);

          if (shouldFetch) {
            logger.info(
              `Condition met for group ${i + 1}, processing streams.`
            );
            allStreams.push(...groupResult.streams);
            allErrors.push(...groupResult.errors);
            allStatisticStreams.push(...groupResult.statistics);
            totalTimeTaken += groupResult.totalTime;
            previousGroupStreams = groupResult.streams;
            previousGroupTimeTaken = groupResult.totalTime;
          } else {
            logger.info(
              `Condition not met for group ${i + 1}, skipping remaining groups.`
            );
            break; // Stop processing any more groups
          }
        }
      }
    } else {
      // If no groups configured, fetch from all addons in parallel
      const result = await fetchFromGroup(addons);
      allStreams.push(...result.streams);
      allErrors.push(...result.errors);
      allStatisticStreams.push(...result.statistics);
    }

    logger.info(
      `Fetched ${allStreams.length} streams from ${addons.length} addons in ${getTimeTakenSincePoint(start)}`
    );
    return {
      streams: allStreams,
      errors: allErrors,
      statistics: allStatisticStreams,
    };
  }
}

export default StreamFetcher;
