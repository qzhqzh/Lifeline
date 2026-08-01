import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({
  schemaVersion: 1,
  projects: [],
  workItems: [],
  runs: [],
  evidence: [],
  events: []
});

export class JsonStore {
  #filePath;
  #state;
  #initialized;
  #writeChain = Promise.resolve();

  constructor(filePath) {
    this.#filePath = filePath;
    this.#initialized = this.#load();
  }

  async #load() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    try {
      const text = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(text);
      this.#state = normalizeState(parsed);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
  }

  async ready() {
    await this.#initialized;
  }

  async read() {
    await this.#initialized;
    await this.#writeChain;
    return structuredClone(this.#state);
  }

  async mutate(mutator) {
    await this.#initialized;
    const operation = this.#writeChain.then(async () => {
      const result = await mutator(this.#state);
      await this.#persist();
      return structuredClone(result);
    });
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  async #persist() {
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;
    const body = `${JSON.stringify(this.#state, null, 2)}\n`;
    await writeFile(tempPath, body, 'utf8');
    await rename(tempPath, this.#filePath);
  }
}

function normalizeState(state) {
  return {
    schemaVersion: Number(state?.schemaVersion) || 1,
    projects: Array.isArray(state?.projects) ? state.projects : [],
    workItems: Array.isArray(state?.workItems) ? state.workItems : [],
    runs: Array.isArray(state?.runs) ? state.runs : [],
    evidence: Array.isArray(state?.evidence) ? state.evidence : [],
    events: Array.isArray(state?.events) ? state.events : []
  };
}
