import * as React from 'react';
import cx from 'classnames';
import { Button } from '@showdex/components/ui';
import { PokemonStatNames } from '@showdex/consts/dex';
import { calcdexSlice, useDispatch } from '@showdex/redux/store';
import { traceHackmonsLatency } from '@showdex/features/hackmons-cup-inference/latencyTrace';
import { buildModifierSelectionPayload } from '@showdex/features/hackmons-cup-inference/modifierSelection';
import { type HackmonsDamageMatch, type HackmonsInferredModifier } from '@showdex/features/hackmons-cup-inference/types';
import { useCalcdexPokeContext } from '../CalcdexPokeContext';
import styles from './HackmonsSpreadEstimate.module.scss';

export interface HackmonsSpreadEstimateProps {
  className?: string;
  style?: React.CSSProperties;
}

// tracks `${battleId}:${calcdexId}` keys whose estimate has already been auto-applied, so the
// first-load default guess fires exactly once per mon (survives the component remounting on reselect)
const autoAppliedEstimates = new Set<string>();

const formatSpread = (
  spread: Showdown.StatsTable,
): string => PokemonStatNames
  .map((stat) => `${stat.toUpperCase()} ${spread?.[stat] ?? 0}`)
  .join(' / ');

const serializeMatches = (
  matches: HackmonsDamageMatch[] = [],
): string => JSON.stringify(matches.map((match) => ({
  eventId: match.eventId,
  turn: match.turn,
  moveName: match.moveName,
  observedDamage: match.observedDamage,
  medianDamage: match.medianDamage,
  rollRange: match.rollRange,
  distance: match.distance,
  error: match.error,
  outlier: match.outlier,
  explainedBy: match.explainedBy,
  ko: match.ko,
})));

const serializeModifiers = (
  modifiers: HackmonsInferredModifier[] = [],
): string => JSON.stringify(modifiers, (key, value) => (
  key === 'candidateMatches' ? undefined : value
));

const formatModifierScope = (
  scope: string | { type?: string; types?: string[]; moveTag?: string; },
): string => {
  if (typeof scope !== 'string') {
    return scope.type || scope.types?.join('/') || scope.moveTag || 'scoped';
  }

  return scope === 'stab' ? 'STAB' : scope
    .replace(/^global-/, '')
    .replace(/-/g, ' ');
};

const formatModifierEffect = (
  modifier: {
    id: string;
    scope: string | { type?: string; types?: string[]; moveTag?: string; };
    multiplier: number;
  },
): string => {
  const scopeLabel = formatModifierScope(modifier.scope);
  const isDamageTakenReduction = modifier.multiplier < 1 && (
    modifier.scope === 'global-def'
      || modifier.scope === 'global-spd'
      || modifier.scope === 'global-both'
      || modifier.scope === 'super-effective-taken'
      || modifier.scope === 'full-hp-taken'
      || (typeof modifier.scope !== 'string' && modifier.id.includes('-taken-'))
  );

  if (!isDamageTakenReduction) {
    return `${scopeLabel} ×${modifier.multiplier}`;
  }

  if (modifier.scope === 'global-def') {
    return `physical damage ×${modifier.multiplier} taken`;
  }

  if (modifier.scope === 'global-spd') {
    return `special damage ×${modifier.multiplier} taken`;
  }

  if (modifier.scope === 'global-both') {
    return `damage ×${modifier.multiplier} taken`;
  }

  return `${scopeLabel} damage ×${modifier.multiplier} taken`;
};

export const HackmonsSpreadEstimate = ({
  className,
  style,
}: HackmonsSpreadEstimateProps): React.JSX.Element => {
  const {
    state,
    playerKey,
    playerPokemon: pokemon,
    updatePokemon,
  } = useCalcdexPokeContext();
  const dispatch = useDispatch();
  const [debugExpanded, setDebugExpanded] = React.useState(false);

  const pokemonId = pokemon?.calcdexId;
  const inference = pokemonId ? state.hackmonsInference?.[pokemonId] : null;
  const estimate = inference?.estimate;
  const inferredModifiers = React.useMemo(
    () => estimate?.inferredModifiers || [],
    [estimate?.inferredModifiers],
  );
  const [selectedModifierIds, setSelectedModifierIds] = React.useState<Record<string, string>>({});
  const selectedModifierId = pokemonId ? selectedModifierIds[pokemonId] || '' : '';
  const selectedModifier = inferredModifiers.find((inferredModifier) => (
    inferredModifier.modifier.id === selectedModifierId
  ));
  const selectedMatches = selectedModifier?.candidateMatches || estimate?.matches || [];
  const isOpponent = state.authPlayerKey
    ? playerKey !== state.authPlayerKey
    : playerKey === state.opponentKey;

  React.useEffect(() => {
    if (!pokemonId || !selectedModifierId || inferredModifiers.some((modifier) => (
      modifier.modifier.id === selectedModifierId
    ))) {
      return;
    }

    setSelectedModifierIds((selected) => {
      if (!(pokemonId in selected)) {
        return selected;
      }

      const next = { ...selected };
      delete next[pokemonId];

      return next;
    });
  }, [inferredModifiers, pokemonId, selectedModifierId]);

  const applyEstimate = () => {
    if (!estimate) {
      return;
    }

    updatePokemon(buildModifierSelectionPayload({
      selection: estimate.selection,
      candidateSpread: estimate,
    }), 'HackmonsSpreadEstimate:Button~Apply:onPress()');

    setSelectedModifierIds((selected) => {
      if (!pokemonId || !(pokemonId in selected)) {
        return selected;
      }

      const next = { ...selected };
      delete next[pokemonId];

      return next;
    });
  };

  // auto-apply the estimate the first time it appears for a given mon (once per battle), so the
  // default guess populates without the user having to press Apply
  React.useEffect(() => {
    if (!isOpponent || !estimate || !pokemonId || document.documentElement.hasAttribute('data-showdex-hackmons-suppress-estimate-apply')) {
      return;
    }

    const key = `${state.battleId}:${pokemonId}`;

    if (autoAppliedEstimates.has(key)) {
      return;
    }

    autoAppliedEstimates.add(key);
    applyEstimate();
  }, [estimate, isOpponent, pokemonId, state.battleId]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!isOpponent || !estimate || !pokemonId || !pokemon?.speciesForme) {
      return;
    }

    const eventCount = inference?.events.length || 0;
    const estimateEvents = serializeMatches(estimate.matches);
    const modifierEvents = serializeModifiers(estimate.inferredModifiers);

    traceHackmonsLatency('estimateRendered', {
      battleId: state.battleId,
      calcdexId: pokemonId,
      eventCount,
      payloadSignature: JSON.stringify({ eventCount, estimateEvents, modifierEvents }),
      modifiers: modifierEvents,
    });
  }, [estimate, inference?.events.length, isOpponent, pokemon?.speciesForme, pokemonId, state.battleId]);

  if (!isOpponent || !estimate || !pokemon?.speciesForme) {
    return null;
  }

  const speedNotes = [...new Set((inference.speedNotes || []).filter(Boolean))];
  const modeledEvents = inference.events.length;
  const outlierEvents = (estimate.matches || []).filter((match) => !!match.outlier).length;
  const estimateEvents = serializeMatches(estimate.matches);
  const selectedEvents = serializeMatches(selectedMatches);
  const modifierEvents = serializeModifiers(inferredModifiers);

  const resetEstimate = () => dispatch(calcdexSlice.actions.resetHackmonsInference({
    battleId: state.battleId,
    pokemonId,
  }));

  const resetSelection = () => {
    setSelectedModifierIds((selected) => {
      if (!pokemonId || !(pokemonId in selected)) {
        return selected;
      }

      const next = { ...selected };
      delete next[pokemonId];

      return next;
    });
  };

  const applyModifier = (inferredModifier: typeof inferredModifiers[number]) => {
    updatePokemon(buildModifierSelectionPayload(inferredModifier), 'HackmonsSpreadEstimate:Modifier:onPress()');
    setSelectedModifierIds((selected) => ({
      ...selected,
      ...(pokemonId ? { [pokemonId]: inferredModifier.modifier.id } : null),
    }));
  };

  return (
    <section
      className={cx(styles.container, className)}
      style={style}
      data-hackmons-event-count={modeledEvents}
      data-hackmons-match-count={estimate.matches?.length || 0}
      data-hackmons-estimate-events={estimateEvents}
      data-hackmons-selected-modifier={selectedModifierId}
      data-hackmons-selected-events={selectedEvents}
      data-hackmons-estimate-selection={JSON.stringify(estimate.selection)}
      data-hackmons-speed-notes={JSON.stringify(speedNotes)}
      data-hackmons-modifiers={modifierEvents}
      data-hackmons-ignored-count={inference.ignoredEventCount || 0}
    >
      <div className={styles.header}>
        <span className={styles.title}>Estimated Spread</span>
        <span className={cx(styles.confidence, styles[estimate.confidence])}>
          {estimate.confidence}
        </span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>IVs</span>
        <span className={styles.value}>{formatSpread(estimate.ivs)}</span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>EVs</span>
        <span className={styles.value}>{formatSpread(estimate.evs)}</span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Nature</span>
        <span className={styles.value}>{estimate.nature}</span>
      </div>

      {!!speedNotes.length && (
        <div className={styles.speed}>
          <span className={styles.label}>Speed</span>
          <div className={styles.speedNotes}>
            {speedNotes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </div>
        </div>
      )}

      {!!inferredModifiers.length && (
        <div className={styles.modifiers}>
          {inferredModifiers.map((modifier) => (
            <span
              key={modifier.modifier.id}
              className={cx(styles.modifier, {
                [styles.possible]: !modifier.adopted,
              })}
              data-hackmons-modifier-id={modifier.modifier.id}
              role="button"
              tabIndex={0}
              onClick={() => applyModifier(modifier)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && applyModifier(modifier)}
            >
              {modifier.adopted ? 'Likely' : 'Possible'}
              {`: ${formatModifierEffect(modifier.modifier)} ${modifier.modifier.slot}`}
              {` (${modifier.modifier.representative})`}
            </span>
          ))}
        </div>
      )}

      <div className={styles.meta}>
        {modeledEvents} modeled damage event{modeledEvents === 1 ? '' : 's'}
        {outlierEvents ? `, ${outlierEvents} outlier${outlierEvents === 1 ? '' : 's'}` : ''}
        {inference.ignoredEventCount ? `, ${inference.ignoredEventCount} unsupported ignored` : ''}
      </div>

      {!!selectedMatches.length && (
        <div className={styles.debug}>
          <span
            className={styles.label}
            role="button"
            tabIndex={0}
            onClick={() => setDebugExpanded(!debugExpanded)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setDebugExpanded(!debugExpanded)}
          >
            {debugExpanded ? '▾' : '▸'}
            {' Debug: Per-Event Matches'}
          </span>
          {debugExpanded && (
            <div className={styles.debugMatches}>
              {selectedMatches.map((match) => (
                <div
                  key={match.eventId}
                  className={cx(styles.debugMatchRow, {
                    [styles.outlier]: !!match.outlier,
                    [styles.error]: !!match.error,
                  })}
                >
                  {`T${match.turn} ${match.moveName}: obs ${match.observedDamage}%`}
                  {match.rollRange ? ` | modeled ${match.rollRange[0]}-${match.rollRange[1]}%` : ''}
                  {typeof match.medianDamage === 'number' ? ` | median ${match.medianDamage}%` : ''}
                  {typeof match.distance === 'number' ? ` | Δ${match.distance}` : ''}
                  {match.ko ? ' | KO (obs truncated)' : ''}
                  {match.explainedBy ? ` | explained by ${match.explainedBy}` : ''}
                  {match.outlier ? ` | ${match.outlier.toUpperCase()}` : ''}
                  {match.error ? ` | ERROR: ${match.error}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.actions}>
        <Button
          className={styles.actionButton}
          label="Apply"
          hoverScale={1}
          onPress={applyEstimate}
        />

        <Button
          className={styles.actionButton}
          label="Reset"
          hoverScale={1}
          onPress={() => {
            resetSelection();
            resetEstimate();
          }}
        />
      </div>
    </section>
  );
};
