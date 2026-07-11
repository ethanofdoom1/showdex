import { formatId } from '@showdex/utils/core';

export const isInferenceFormat = (format: string): boolean => {
  const id = formatId(format);

  return id.includes('hackmons') || id.includes('brokencup');
};
