export interface ApiKeyRecord {
  access?: Record<string, unknown>;
  dateAdded?: string;
  key: string;
  lastUsed?: string;
  name?: string;
  userID: number;
}

export interface GroupRecord {
  data: {
    fileEditing: string;
    description?: string;
    hasImage?: boolean | number | string;
    id: number;
    libraryEditing: string;
    libraryReading: string;
    name: string;
    owner: number;
    type: string;
    url?: string;
    version: number;
  };
  id: number;
}

export interface ItemRecord {
  data: Record<string, unknown>;
  key: string;
  version: number;
}

interface LibraryState {
  items: Map<string, ItemRecord>;
  version: number;
}

interface CompatibilityState {
  apiKeys: Map<string, ApiKeyRecord>;
  groups: Map<number, GroupRecord>;
  libraries: Map<number, LibraryState>;
  nextGroupID: number;
  usedWriteTokens: Set<string>;
}

const createLibrary = (): LibraryState => ({
  items: new Map(),
  version: 0,
});

const createState = (): CompatibilityState => ({
  apiKeys: new Map(),
  groups: new Map(),
  libraries: new Map(),
  nextGroupID: 1,
  usedWriteTokens: new Set(),
});

const state = createState();

export const resetState = () => {
  state.apiKeys.clear();
  state.groups.clear();
  state.libraries.clear();
  state.nextGroupID = 1;
  state.usedWriteTokens.clear();
};

export const getState = (): CompatibilityState => state;

export const getLibrary = (userID: number): LibraryState => {
  const existing = state.libraries.get(userID);
  if (existing) {
    return existing;
  }

  const library = createLibrary();
  state.libraries.set(userID, library);
  return library;
};

export const clearLibrary = (userID: number) => {
  state.libraries.set(userID, createLibrary());
};
