export interface Bindings {
  ATTACHMENTS: R2Bucket;
  DB: D1Database;
  RAW_FILE_URL_SECRET?: string;
  ROOT_PASSWORD?: string;
  ROOT_USERNAME?: string;
  SELFHOST_TEST_API_KEY?: string;
  TTS_TEST_KEY?: string;
}
