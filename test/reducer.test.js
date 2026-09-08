import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceJourney } from '../src/reducer.js';

const actions = (...ids) => ids.map((id) => ({ id, type: 'click', selector: `#${id}` }));
const ids = (candidate) => candidate.map((action) => action.id);
const oracle = (predicate) => async (candidate) => ({
  outcome: predicate(ids(candidate)) ? 'reproduced' : 'not-reproduced',
  durationMs: 1,
});

test('finds an ordered reproducer while rejecting invalid action sequences', async () => {
  const original = actions('noise-a', 'start', 'noise-b', 'crash', 'noise-c');
  const result = await reduceJourney(original, async (candidate) => {
    const order = ids(candidate);
    if (order.includes('crash') && !order.includes('start')) {
      return { outcome: 'invalid', failedActionId: 'crash', durationMs: 1 };
    }
    return { outcome: order.includes('start') && order.includes('crash')
      ? 'reproduced' : 'not-reproduced', durationMs: 1 };
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(ids(result.reducedActions), ['start', 'crash']);
  assert.equal(result.oneMinimal, true);
  assert.equal(result.verified, true);
  assert.equal(result.confirmations, 2);
  assert.equal(result.runs, result.trials.length);
  assert.ok(result.trials.some((trial) => trial.outcome === 'invalid'));
  assert.deepEqual(ids(original), ['noise-a', 'start', 'noise-b', 'crash', 'noise-c']);
});

test('a non-monotone oracle can be 1-minimal without being globally shortest', async () => {
  const failing = new Set(['a,b,c,d', 'a,c', 'b']);
  const result = await reduceJourney(actions('a', 'b', 'c', 'd'), oracle((order) => failing.has(order.join(','))));
  assert.equal(result.status, 'complete');
  assert.equal(result.oneMinimal, true);
  assert.deepEqual(ids(result.reducedActions), ['a', 'b', 'c', 'd']);
  const deletions = result.trials.filter((trial) => trial.phase === 'verify');
  assert.equal(deletions.length, 4);
  assert.ok(deletions.every((trial) => trial.outcome === 'not-reproduced'));
});

test('all deterministic predicates on three ordered actions yield a valid 1-minimal result', async () => {
  const original = actions('a', 'b', 'c');
  const subsetIndex = (order) => order.reduce((mask, id) => mask | (1 << ['a', 'b', 'c'].indexOf(id)), 0);
  // Eight possible subsets, and all 128 truth tables whose full input fails.
  // This includes predicates that have no monotonic relationship to deletion.
  for (let truthTable = 128; truthTable < 256; truthTable += 1) {
    const reproduces = (order) => Boolean(truthTable & (1 << subsetIndex(order)));
    const result = await reduceJourney(original, oracle(reproduces));
    const reduced = ids(result.reducedActions);
    assert.equal(result.status, 'complete', `truth table ${truthTable}`);
    assert.equal(result.oneMinimal, true);
    assert.equal(reproduces(reduced), true);
    assert.deepEqual(reduced, ids(original).filter((id) => reduced.includes(id)));
    for (let index = 0; index < reduced.length; index += 1) {
      assert.equal(reproduces(reduced.filter((_, item) => item !== index)), false,
        `truth table ${truthTable}, deleting ${reduced[index]}`);
    }
  }
});

test('explicitly checks the empty candidate and can accept it', async () => {
  const result = await reduceJourney(actions('a', 'b'), oracle(() => true));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.reducedActions, []);
  assert.equal(result.oneMinimal, true);
  assert.equal(result.runs, 6);
  assert.deepEqual(result.trials.map((trial) => trial.phase), ['baseline', 'baseline', 'empty', 'empty', 'final', 'final']);
});

test('an already empty reproducer still receives baseline and final replays', async () => {
  const result = await reduceJourney([], oracle(() => true));
  assert.equal(result.status, 'complete');
  assert.equal(result.oneMinimal, true);
  assert.equal(result.runs, 4);
});

test('a necessary single action is retained and its deletion is verified', async () => {
  const result = await reduceJourney(actions('a'), oracle((order) => order.length > 0));
  assert.equal(result.status, 'complete');
  assert.deepEqual(ids(result.reducedActions), ['a']);
  assert.deepEqual(result.trials.filter((trial) => trial.phase === 'verify').map((trial) => trial.actionIds), [[]]);
});

test('a consistently missing baseline stops without reducing', async () => {
  const result = await reduceJourney(actions('a'), oracle(() => false), { confirmations: 3 });
  assert.equal(result.status, 'baseline-not-reproduced');
  assert.equal(result.runs, 3);
  assert.equal(result.verified, false);
  assert.equal(result.oneMinimal, false);
  assert.equal(result.confirmations, 0);
});

test('mixed baseline observations are unstable even when the last replay succeeds', async () => {
  const outcomes = ['reproduced', 'not-reproduced', 'reproduced'];
  const result = await reduceJourney(actions('a'), async () => ({ outcome: outcomes.shift() }), { confirmations: 3 });
  assert.equal(result.status, 'unstable');
  assert.equal(result.runs, 3);
  assert.equal(result.verified, false);
  assert.equal(result.finalTrial, null);
});

test('consistently invalid baseline trials cannot establish reproduction', async () => {
  const result = await reduceJourney(actions('a'), async () => ({ outcome: 'invalid', failedActionId: 'a' }));
  assert.equal(result.status, 'baseline-not-reproduced');
  assert.equal(result.oneMinimal, false);
});

test('every replay, including confirmation, stays inside all small budgets', async () => {
  for (let maxRuns = 0; maxRuns <= 20; maxRuns += 1) {
    let calls = 0;
    const result = await reduceJourney(actions('a', 'b', 'c'), async (candidate) => {
      calls += 1;
      return { outcome: ids(candidate).includes('b') ? 'reproduced' : 'not-reproduced' };
    }, { maxRuns });
    assert.ok(calls <= maxRuns, `maxRuns=${maxRuns}, actual=${calls}`);
    assert.equal(result.runs, calls);
    assert.equal(result.trials.length, calls);
    if (result.status === 'complete') {
      assert.equal(result.verified, true);
      assert.equal(result.oneMinimal, true);
      assert.equal(result.confirmations, 2);
    }
  }
});

test('a budget smaller than baseline confirmation is explicitly unverified', async () => {
  const result = await reduceJourney(actions('a'), oracle(() => true), { maxRuns: 1 });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.runs, 1);
  assert.equal(result.verified, false);
  assert.equal(result.oneMinimal, false);
  assert.equal(result.confirmations, 0);
});

test('an insufficient final budget reports partial confirmations without verification', async () => {
  const result = await reduceJourney(actions('a'), oracle(() => true), { maxRuns: 3 });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.runs, 3);
  assert.equal(result.confirmations, 1);
  assert.equal(result.verified, false);
  assert.equal(result.oneMinimal, false);
});

test('final confirmations are reserved before any reduction trial', async () => {
  const result = await reduceJourney(actions('a'), oracle(() => true), { maxRuns: 4 });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.verified, true);
  assert.equal(result.oneMinimal, false);
  assert.deepEqual(ids(result.reducedActions), ['a']);
  assert.deepEqual(result.trials.map((trial) => trial.phase), ['baseline', 'baseline', 'final', 'final']);
});

test('a candidate with only a partial successful confirmation is never accepted', async () => {
  const result = await reduceJourney(actions('a'), oracle(() => true), { maxRuns: 5 });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.verified, true);
  assert.deepEqual(ids(result.reducedActions), ['a']);
  assert.equal(result.trials.filter((trial) => trial.phase === 'empty').length, 1);
  assert.equal(result.runs, 5);
});

test('1-minimal is withheld until every final single deletion was checked', async () => {
  const run = oracle((order) => order.length === 2);
  const incomplete = await reduceJourney(actions('a', 'b'), run, { maxRuns: 8 });
  assert.equal(incomplete.status, 'budget-exhausted');
  assert.equal(incomplete.verified, true);
  assert.equal(incomplete.oneMinimal, false);
  assert.equal(incomplete.trials.filter((trial) => trial.phase === 'verify').length, 1);
  const complete = await reduceJourney(actions('a', 'b'), run, { maxRuns: 9 });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.oneMinimal, true);
  assert.equal(complete.trials.filter((trial) => trial.phase === 'verify').length, 2);
});

test('an intermittent candidate is rejected, retaining the prior confirmed journey', async () => {
  let emptyCalls = 0;
  const result = await reduceJourney(actions('a'), async (candidate) => ({
    outcome: candidate.length > 0 || ++emptyCalls === 1 ? 'reproduced' : 'not-reproduced',
  }));
  assert.equal(result.status, 'unstable');
  assert.deepEqual(ids(result.reducedActions), ['a']);
  assert.equal(result.verified, true);
  assert.equal(result.oneMinimal, false);
  assert.equal(result.confirmations, 2);
});

test('failure in final confirmation invalidates both verification and 1-minimality', async () => {
  const outcomes = ['reproduced', 'reproduced', 'not-reproduced', 'reproduced'];
  const result = await reduceJourney([], async () => ({ outcome: outcomes.shift() }));
  assert.equal(result.status, 'unstable');
  assert.equal(result.verified, false);
  assert.equal(result.oneMinimal, false);
  assert.equal(result.confirmations, 1);
  assert.equal(result.runs, 4);
});

test('a wholly missing final failure is unstable relative to the confirmed baseline', async () => {
  let calls = 0;
  const result = await reduceJourney([], async () => ({ outcome: ++calls <= 2 ? 'reproduced' : 'not-reproduced' }));
  assert.equal(result.status, 'unstable');
  assert.equal(result.confirmations, 0);
  assert.equal(result.verified, false);
});

test('all trials reach the observer and final evidence requires no extra replay', async () => {
  const captures = [];
  const observed = [];
  const result = await reduceJourney(actions('a'), async (candidate, { capture }) => {
    captures.push(capture);
    return { outcome: 'reproduced', durationMs: 0, evidence: { matched: ['target'], ...(capture ? { screenshot: 'png' } : {}) } };
  }, { onTrial: async (trial) => observed.push(trial) });
  assert.deepEqual(observed, result.trials);
  assert.deepEqual(observed.map((trial) => trial.index), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(captures, [false, false, false, false, false, true]);
  assert.equal(result.finalTrial.evidence.screenshot, 'png');
  assert.equal(result.finalTrial, result.trials.at(-1));
  assert.ok(observed.every((trial) => trial.durationMs === 0));
});

test('runner exceptions and malformed outcomes are counted as invalid trials', async () => {
  let calls = 0;
  const result = await reduceJourney(actions('a'), async () => {
    calls += 1;
    if (calls === 1) throw new Error('browser unavailable');
    return { outcome: 'success' };
  });
  assert.equal(result.status, 'baseline-not-reproduced');
  assert.equal(result.runs, 2);
  assert.equal(result.trials[0].error, 'browser unavailable');
  assert.match(result.trials[1].error, /invalid trial outcome/);
  assert.ok(result.trials.every((trial) => trial.durationMs >= 0));
});

test('input validation rejects malformed actions and impossible budget options', async () => {
  const run = oracle(() => true);
  await assert.rejects(reduceJourney(null, run), /actions must be an array/);
  await assert.rejects(reduceJourney(actions('a', 'a'), run), /unique/);
  await assert.rejects(reduceJourney([{}], run), /unique/);
  await assert.rejects(reduceJourney(actions('a'), null), /run must be/);
  for (const maxRuns of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(reduceJourney([], run, { maxRuns }), /maxRuns/);
  }
  for (const confirmations of [0, -1, 1.5, Infinity]) {
    await assert.rejects(reduceJourney([], run, { confirmations }), /confirmations/);
  }
  await assert.rejects(reduceJourney([], run, { onTrial: null }), /onTrial/);
});
