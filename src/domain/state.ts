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
  createdByUserID?: number;
  data: Record<string, unknown>;
  key: string;
  lastModifiedByUserID?: number;
  version: number;
}
