import { UserData } from '../db/schemas';
import { Env } from './env';

const DEFAULT_REASON = 'Disabled by owner of the instance';

export class FeatureControl {
  private static readonly _allowedRegexPatterns: {
    patterns: string[];
    description?: string;
  } = (() => {
    return {
      patterns: Env.ALLOWED_REGEX_PATTERNS,
      description: Env.ALLOWED_REGEX_PATTERNS_DESCRIPTION,
    };
  })();

  private static readonly _disabledHosts: Map<string, string> = (() => {
    const map = new Map<string, string>();
    if (Env.DISABLED_HOSTS) {
      for (const disabledHost of Env.DISABLED_HOSTS.split(',')) {
        const [host, reason] = disabledHost.split(':');
        map.set(host, reason || DEFAULT_REASON);
      }
    }
    return map;
  })();

  private static readonly _disabledAddons: Map<string, string> = (() => {
    const map = new Map<string, string>();
    if (Env.DISABLED_ADDONS) {
      for (const disabledAddon of Env.DISABLED_ADDONS.split(',')) {
        const [addon, reason] = disabledAddon.split(':');
        map.set(addon, reason || DEFAULT_REASON);
      }
    }
    return map;
  })();

  private static readonly _disabledServices: Map<string, string> = (() => {
    const map = new Map<string, string>();
    if (Env.DISABLED_SERVICES) {
      for (const disabledService of Env.DISABLED_SERVICES.split(',')) {
        const [service, reason] = disabledService.split(':');
        map.set(service, reason || DEFAULT_REASON);
      }
    }
    return map;
  })();

  public static readonly regexFilterAccess: 'none' | 'trusted' | 'all' =
    Env.REGEX_FILTER_ACCESS;

  public static get disabledHosts() {
    return this._disabledHosts;
  }

  public static get disabledAddons() {
    return this._disabledAddons;
  }

  public static get disabledServices() {
    return this._disabledServices;
  }

  public static get allowedRegexPatterns() {
    return this._allowedRegexPatterns;
  }

  public static isRegexAllowed(userData: UserData, regexes?: string[]) {
    if (regexes && regexes.length > 0) {
      const areAllRegexesAllowed = regexes.every((regex) =>
        this.allowedRegexPatterns.patterns.includes(regex)
      );
      if (areAllRegexesAllowed) {
        return true;
      }
    }
    switch (this.regexFilterAccess) {
      case 'trusted':
        return userData.trusted ?? false;
      case 'all':
        return true;
      default:
        return false;
    }
  }
}
