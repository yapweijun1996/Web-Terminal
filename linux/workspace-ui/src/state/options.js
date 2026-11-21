const storageKey = 'workspace-model-choices';

export function readModelChoices(storage = () => globalThis.localStorage) {
  try {
    const choices = JSON.parse(storage().getItem(storageKey));
    return choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {};
  } catch {
    return {};
  }
}

export function writeModelChoices(choices, storage = () => globalThis.localStorage) {
  try {
    storage().setItem(storageKey, JSON.stringify(choices));
  } catch {
    // Preferences still work for the current page when storage is unavailable.
  }
}

export function resolveModelChoice(options, preferred) {
  if (!options?.models?.length) return undefined;
  const model = options.models.find(({ id }) => id === preferred?.model)
    ?? options.models.find(({ id }) => id === options.default)
    ?? options.models[0];
  const effort = model.efforts.includes(preferred?.effort) ? preferred.effort
    : model.efforts.includes(options.defaultEffort) ? options.defaultEffort : model.efforts[0];
  return { model: model.id, effort };
}

export function sessionNeedsNewChoice(session, choice) {
  return Boolean(session && choice && (session.model !== choice.model || session.effort !== choice.effort));
}
