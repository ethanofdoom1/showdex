import * as React from 'react';
import cx from 'classnames';
import { Button } from '@showdex/components/ui';
import { PokemonStatNames } from '@showdex/consts/dex';
import { calcdexSlice, useDispatch } from '@showdex/redux/store';
import { useCalcdexPokeContext } from '../CalcdexPokeContext';
import styles from './HackmonsSpreadEstimate.module.scss';

export interface HackmonsSpreadEstimateProps {
  className?: string;
  style?: React.CSSProperties;
}

const formatSpread = (
  spread: Showdown.StatsTable,
): string => PokemonStatNames
  .map((stat) => `${stat.toUpperCase()} ${spread?.[stat] ?? 0}`)
  .join(' / ');

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

  const pokemonId = pokemon?.calcdexId;
  const inference = pokemonId ? state.hackmonsInference?.[pokemonId] : null;
  const estimate = inference?.estimate;
  const isOpponent = state.authPlayerKey
    ? playerKey !== state.authPlayerKey
    : playerKey === state.opponentKey;

  if (!isOpponent || !estimate || !pokemon?.speciesForme) {
    return null;
  }

  const speedNotes = [...new Set((inference.speedNotes || []).filter(Boolean))];
  const modeledEvents = inference.events.length;
  const outlierEvents = (estimate.matches || []).filter((match) => !!match.outlier).length;
  const estimateEvents = JSON.stringify((estimate.matches || []).map((match) => ({
    eventId: match.eventId,
    turn: match.turn,
    moveName: match.moveName,
    observedDamage: match.observedDamage,
    medianDamage: match.medianDamage,
    rollRange: match.rollRange,
    distance: match.distance,
    error: match.error,
    outlier: match.outlier,
    ko: match.ko,
  })));

  const applyEstimate = () => updatePokemon({
    nature: estimate.nature,
    ivs: {
      ...pokemon.ivs,
      ...estimate.ivs,
    },
    evs: {
      ...pokemon.evs,
      ...estimate.evs,
    },
  }, 'HackmonsSpreadEstimate:Button~Apply:onPress()');

  const resetEstimate = () => dispatch(calcdexSlice.actions.resetHackmonsInference({
    battleId: state.battleId,
    pokemonId,
  }));

  return (
    <section
      className={cx(styles.container, className)}
      style={style}
      data-hackmons-event-count={modeledEvents}
      data-hackmons-match-count={estimate.matches?.length || 0}
      data-hackmons-estimate-events={estimateEvents}
      data-hackmons-speed-notes={JSON.stringify(speedNotes)}
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

      <div className={styles.meta}>
        {modeledEvents} modeled damage event{modeledEvents === 1 ? '' : 's'}
        {outlierEvents ? `, ${outlierEvents} outlier${outlierEvents === 1 ? '' : 's'}` : ''}
        {inference.ignoredEventCount ? `, ${inference.ignoredEventCount} unsupported ignored` : ''}
      </div>

      {/*
        TEMPORARY: manual-testing aid for reviewing per-event matches directly in a real battle
        (rather than only via the e2e debug script). Ask to remove this block once done reviewing.
      */}
      {!!estimate.matches?.length && (
        <div className={styles.debug}>
          <span className={styles.label}>Debug: Per-Event Matches (temporary)</span>
          <div className={styles.debugMatches}>
            {estimate.matches.map((match) => (
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
                {match.outlier ? ` | ${match.outlier.toUpperCase()}` : ''}
                {match.error ? ` | ERROR: ${match.error}` : ''}
              </div>
            ))}
          </div>
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
          onPress={resetEstimate}
        />
      </div>
    </section>
  );
};
