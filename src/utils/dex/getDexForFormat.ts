import { type GenerationNum } from '@smogon/calc';
import { formatId } from '@showdex/utils/core';
import { logger } from '@showdex/utils/debug';
import { detectGenFromFormat } from './detectGenFromFormat';

const l = logger('@showdex/utils/dex/getDexForFormat()');

const resolveDexForFormat = (format?: string | GenerationNum): Showdown.ModdedDex => {
  if (typeof Dex === 'undefined') {
    if (__DEV__) {
      l.warn(
        'Global Dex object is not available.',
        '\n', 'format', format,
        '\n', '(You will only see this warning on development.)',
      );
    }

    return null;
  }

  if (!format) {
    return Dex;
  }

  // note: checking if `format > 0` in the conditional won't guarantee that `format` will
  // be type `string` after this point
  if (typeof format === 'number') {
    return format > 0 ? Dex.forGen(format) : Dex;
  }

  const formatAsId = formatId(format);

  if (formatAsId.includes('letsgo')) {
    return Dex.mod('gen7letsgo');
  }

  if (formatAsId.includes('bdsp')) {
    return Dex.mod('gen8bdsp');
  }

  if (formatAsId.includes('champions')) {
    return Dex.mod('champions');
  }

  const gen = detectGenFromFormat(formatAsId);

  if (typeof gen !== 'number' || gen < 1) {
    return Dex;
  }

  return Dex.forGen(gen);
};

// the format string is re-parsed on every call, and hot paths (the Hackmons spread search) make thousands
// per sync with the same one or two formats -- resolved once per format for as long as the global Dex is
// the same object
let memoizedFor: typeof Dex = null;
const memoized = new Map<string | GenerationNum, Showdown.ModdedDex>();

/**
 * Returns the appropriate `Dex` object for the passed-in `format`.
 *
 * * For BDSP formats, returns a modded `Dex` containing all the Gen 4 Pokemon normally unavailable in Gen 8.
 * * For other formats, returns a `Dex` for the current gen specified in the `format`.
 *   - Gen value is obtained via `detectGenFromFormat()`.
 * * If no `format` is provided or an invalid gen was returned from the `format`,
 *   the global `Dex` object is returned instead, which should default to the current gen.
 * * Note that `format` can also be a number representing the gen number.
 *
 * @since 1.0.2
 */
export const getDexForFormat = (format?: string | GenerationNum): Showdown.ModdedDex => {
  if (typeof Dex === 'undefined') {
    return resolveDexForFormat(format);
  }

  if (memoizedFor !== Dex) {
    memoizedFor = Dex;
    memoized.clear();
  }

  const key = format ?? '';

  if (!memoized.has(key)) {
    memoized.set(key, resolveDexForFormat(format));
  }

  return memoized.get(key);
};
