const OUTCOMES = new Set(['reproduced', 'not-reproduced', 'invalid']);

/**
 * Reduce an ordered action list with bounded, repeated oracle observations.
 * A complete result is 1-minimal under the observed oracle: no individual
 * action can be deleted. Non-monotone faults may have smaller reproducers.
 * Every replay, including baseline and final evidence, consumes maxRuns.
 */
export async function reduceJourney(actions, run, {
  maxRuns = 80,
  confirmations = 2,
  onTrial = () => {},
} = {}) {
  validateArguments(actions, run, maxRuns, confirmations, onTrial);

  const originalCount = actions.length;
  let current = [...actions];
  const trials = [];
  let finalTrial = null;
  let searchFinished = false;
  let observedInstability = false;
  let budgetReached = false;

  const replay = async (candidate, phase, capture = false) => {
    // Callers reserve the final budget; this guard also prevents accidental
    // future search changes from performing an uncounted oracle call.
    if (trials.length >= maxRuns) throw new Error('Replay budget exhausted');
    const actionIds = candidate.map((action) => action.id);
    const started = performance.now();
    let observed;
    try {
      observed = await run([...candidate], { capture });
      if (!observed || !OUTCOMES.has(observed.outcome)) {
        observed = { outcome: 'invalid', error: 'Runner returned an invalid trial outcome' };
      }
    } catch (error) {
      observed = {
        outcome: 'invalid',
        error: String(error instanceof Error ? error.message : error).slice(0, 2000),
      };
    }
    const trial = {
      ...observed,
      index: trials.length + 1,
      phase,
      actionIds,
      durationMs: Number.isFinite(observed.durationMs) && observed.durationMs >= 0
        ? observed.durationMs
        : performance.now() - started,
    };
    trials.push(trial);
    await onTrial(trial);
    return trial;
  };

  const result = (status, verified = false, finalConfirmations = 0, reason) => ({
    status,
    originalCount,
    reducedActions: [...current],
    trials,
    runs: trials.length,
    oneMinimal: status === 'complete' && verified && searchFinished,
    confirmations: finalConfirmations,
    verified,
    reason,
    finalTrial,
  });

  const baseline = [];
  for (let attempt = 0; attempt < confirmations && trials.length < maxRuns; attempt += 1) {
    baseline.push((await replay(current, 'baseline')).outcome);
  }
  if (new Set(baseline).size > 1) {
    return result('unstable', false, 0, 'Baseline replays produced different outcomes.');
  }
  if (baseline.length < confirmations) {
    return result('budget-exhausted', false, 0, 'Budget ended before baseline confirmation.');
  }
  if (baseline.some((outcome) => outcome !== 'reproduced')) {
    return result('baseline-not-reproduced', false, 0, 'The original journey did not reproduce the target failure.');
  }

  // No cache: repeated observations are real replays and can reveal flakes.
  // A candidate must pass all confirmations before it replaces current.
  const consider = async (candidate, phase) => {
    let successes = 0;
    for (let attempt = 0; attempt < confirmations; attempt += 1) {
      if (maxRuns - trials.length <= confirmations) {
        budgetReached = true;
        return 'budget';
      }
      const trial = await replay(candidate, phase);
      if (trial.outcome !== 'reproduced') {
        if (successes > 0) {
          observedInstability = true;
          return 'unstable';
        }
        return 'rejected';
      }
      successes += 1;
    }
    current = candidate;
    return 'accepted';
  };

  if (current.length === 0) {
    searchFinished = true;
  } else {
    // A failure may need no reducible steps at all (for example a timer
    // started during setup). Partitioning alone never checks this case.
    const empty = await consider([], 'empty');
    if (empty === 'accepted') searchFinished = true;

    let granularity = 2;
    while (!searchFinished && !budgetReached && !observedInstability && current.length >= 2) {
      const length = current.length;
      const partitions = Math.min(granularity, length);
      let accepted = false;
      for (let part = 0; part < partitions; part += 1) {
        const start = Math.floor(part * length / partitions);
        const end = Math.floor((part + 1) * length / partitions);
        const candidate = [...current.slice(0, start), ...current.slice(end)];
        const decision = await consider(candidate, 'reduce');
        if (decision === 'accepted') {
          accepted = true;
          granularity = Math.max(2, partitions - 1);
          break;
        }
        if (decision === 'budget' || decision === 'unstable') break;
      }
      if (accepted) continue;
      if (partitions === length) break;
      granularity = Math.min(length, partitions * 2);
    }

    // Verify every single deletion against the final candidate. Any accepted
    // deletion restarts this sweep because the oracle need not be monotone.
    while (!searchFinished && !budgetReached && !observedInstability) {
      let accepted = false;
      let rejected = 0;
      for (let index = 0; index < current.length; index += 1) {
        const candidate = [...current.slice(0, index), ...current.slice(index + 1)];
        const decision = await consider(candidate, 'verify');
        if (decision === 'accepted') {
          accepted = true;
          break;
        }
        if (decision === 'budget' || decision === 'unstable') break;
        rejected += 1;
      }
      if (!accepted && rejected === current.length && !budgetReached && !observedInstability) {
        searchFinished = true;
      }
      if (current.length === 0) searchFinished = true;
    }
  }

  // Final confirmation is separate from candidate acceptance and included in
  // maxRuns. Capture only the last replay so callers need no extra evidence run.
  const finalOutcomes = [];
  const finalAttempts = Math.min(confirmations, maxRuns - trials.length);
  for (let attempt = 0; attempt < finalAttempts; attempt += 1) {
    finalTrial = await replay(current, 'final', attempt === finalAttempts - 1);
    finalOutcomes.push(finalTrial.outcome);
  }
  const successfulFinals = finalOutcomes.filter((outcome) => outcome === 'reproduced').length;
  const verified = finalAttempts === confirmations && successfulFinals === confirmations;
  if (observedInstability || finalOutcomes.some((outcome) => outcome !== 'reproduced')) {
    return result('unstable', verified, successfulFinals,
      observedInstability
        ? 'A candidate produced mixed outcomes; the previous confirmed candidate was retained.'
        : 'The retained candidate failed final confirmation.');
  }
  if (!verified || !searchFinished || budgetReached) {
    return result('budget-exhausted', verified, successfulFinals,
      verified
        ? 'The retained candidate is confirmed; the budget ended before all single deletions were checked.'
        : 'The budget ended before final confirmation.');
  }
  return result('complete', true, successfulFinals,
    'The retained candidate is confirmed and every single deletion was rejected.');
}

function validateArguments(actions, run, maxRuns, confirmations, onTrial) {
  if (!Array.isArray(actions)) throw new TypeError('actions must be an array');
  const ids = new Set();
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)
      || typeof action.id !== 'string' || action.id.length === 0 || ids.has(action.id)) {
      throw new TypeError('Every action must have a unique, non-empty string id');
    }
    ids.add(action.id);
  }
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 0) {
    throw new RangeError('maxRuns must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new RangeError('confirmations must be a positive safe integer');
  }
  if (typeof onTrial !== 'function') throw new TypeError('onTrial must be a function');
}
