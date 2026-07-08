# Official dataserver reference stack runbook

This runbook is for bringing up Zotero's official PHP `dataserver` locally as a
reference target for compatibility work. It is not the production server we are
building. The production/candidate server lives under `server/`.

Authoritative local source:

```text
references/dataserver/
```

Useful comparison source:

```text
references/zotero-selfhost/
```

The older `references/zotero-selfhost` Compose stack is useful for service
shape and bootstrap order, but it is not authoritative for current Zotero
behavior.

## Required services

The official `dataserver` repo does not include a complete local Docker stack.
The config samples and old self-hosting attempt show these required services for
reference bring-up:

| Service | Purpose | Starting local choice |
| --- | --- | --- |
| PHP web server | Runs `htdocs/index.php` and the PHP API controllers | PHP + Apache or nginx/FPM image |
| Composer deps | Installs PHP dependencies from `references/dataserver/composer.json` | `composer install` inside app image |
| MySQL | Master metadata, shards, ID DB, and WWW auth/storage metadata | MySQL 5.7-compatible config first |
| Redis | Request limiter, notifications, migration queues | Redis 5+ |
| Memcached | Response/cache layer used by models | Memcached 1.5+ |
| S3-compatible object store | Attachment/full-text/object storage | MinIO for local |
| Elasticsearch | Full-text/search surfaces | Elasticsearch 7.x first because composer requires `elasticsearch/elasticsearch:^7.11` |
| SNS/SQS-compatible services | Alert/queue surfaces used by ancillary flows | LocalStack if those paths are enabled |

For the first reference target, keep optional surfaces disabled unless a test
slice needs them. The tiny API smoke slice should not need translation servers,
citation servers, StatsD, Scribe, TTS, or HTML cleaning.

## PHP config files

Create these files inside the reference checkout. They are intentionally not
committed under `references/dataserver/include/config/`.

```text
references/dataserver/include/config/config.inc.php
references/dataserver/include/config/dbconnect.inc.php
```

Start from the official samples:

```bash
cp references/dataserver/include/config/config.inc.php-sample \
  references/dataserver/include/config/config.inc.php

cp references/dataserver/include/config/dbconnect.inc.php-sample \
  references/dataserver/include/config/dbconnect.inc.php
```

Minimum local `Z_CONFIG` values for the reference target:

```php
public static $TESTING_SITE = true;
public static $DEV_SITE = true;
public static $DEBUG_LOG = true;

public static $BASE_URI = 'http://localhost:8080/';
public static $API_BASE_URI = 'http://localhost:8080/';
public static $WWW_BASE_URI = 'http://localhost:8080/';

public static $AUTH_SALT = 'local-reference-auth-salt';
public static $API_SUPER_USERNAME = 'admin';
public static $API_SUPER_PASSWORD = 'admin';

public static $AWS_REGION = 'us-east-1';
public static $AWS_ACCESS_KEY = 'zotero';
public static $AWS_SECRET_KEY = 'zoterodocker';
public static $S3_BUCKET = 'zotero-reference-files';
public static $S3_BUCKET_FULLTEXT = 'zotero-reference-fulltext';
public static $S3_BUCKET_CACHE = '';
public static $S3_BUCKET_ERRORS = '';

public static $REDIS_HOSTS = [
  'default' => ['host' => 'redis:6379'],
  'request-limiter' => ['host' => 'redis:6379'],
  'notifications' => ['host' => 'redis:6379'],
  'fulltext-migration' => ['host' => 'redis:6379', 'cluster' => false],
];

public static $MEMCACHED_ENABLED = true;
public static $MEMCACHED_SERVERS = ['memcached:11211:1'];

public static $SEARCH_HOSTS = ['elasticsearch:9200'];
public static $STATSD_ENABLED = false;
public static $LOG_TO_SCRIBE = false;
public static $HTMLCLEAN_SERVER_URL = '';
```

Minimum `dbconnect.inc.php` database mapping:

```php
if ($db == 'master') {
  $host = 'mysql';
  $port = 3306;
  $db = 'zotero_master';
  $user = 'root';
  $pass = 'zotero';
  $state = 'up';
}
else if ($db == 'shard') {
  $host = 'mysql';
  $port = 3306;
  $db = 'zotero_shard_1';
  $user = 'root';
  $pass = 'zotero';
}
else if ($db == 'id1' || $db == 'id2') {
  $host = 'mysql';
  $port = 3306;
  $db = 'zotero_ids';
  $user = 'root';
  $pass = 'zotero';
}
else if ($db == 'www1' || $db == 'www2') {
  $host = 'mysql';
  $port = 3306;
  $db = 'zotero_www';
  $user = 'root';
  $pass = 'zotero';
}
```

## MySQL reset/bootstrap order

Schema sources:

```text
references/dataserver/misc/master.sql
references/dataserver/misc/coredata.sql
references/dataserver/misc/shard.sql
references/dataserver/misc/triggers.sql
references/dataserver/misc/ids.sql
references/dataserver/misc/events.sql
references/zotero-selfhost/config/dataserver-scripts/www.sql
```

The old self-hosting stack bootstraps MySQL in this order:

```bash
MYSQL='mysql -h mysql -P 3306 -u root -pzotero'

echo "SET @@global.innodb_large_prefix = 1;" | $MYSQL
echo "SET GLOBAL sql_mode = '';" | $MYSQL

echo "DROP DATABASE IF EXISTS zotero_master;" | $MYSQL
echo "DROP DATABASE IF EXISTS zotero_shard_1;" | $MYSQL
echo "DROP DATABASE IF EXISTS zotero_shard_2;" | $MYSQL
echo "DROP DATABASE IF EXISTS zotero_ids;" | $MYSQL
echo "DROP DATABASE IF EXISTS zotero_www;" | $MYSQL

echo "CREATE DATABASE zotero_master;" | $MYSQL
echo "CREATE DATABASE zotero_shard_1;" | $MYSQL
echo "CREATE DATABASE zotero_shard_2;" | $MYSQL
echo "CREATE DATABASE zotero_ids;" | $MYSQL
echo "CREATE DATABASE zotero_www;" | $MYSQL

$MYSQL zotero_master < references/dataserver/misc/master.sql
$MYSQL zotero_master < references/dataserver/misc/coredata.sql

echo "INSERT INTO shardHosts VALUES (1, 'mysql', 3306, 'up');" | $MYSQL zotero_master
echo "INSERT INTO shards VALUES (1, 1, 'zotero_shard_1', 'up', '1');" | $MYSQL zotero_master
echo "INSERT INTO shards VALUES (2, 1, 'zotero_shard_2', 'up', '1');" | $MYSQL zotero_master

$MYSQL zotero_shard_1 < references/dataserver/misc/shard.sql
$MYSQL zotero_shard_1 < references/dataserver/misc/triggers.sql
$MYSQL zotero_shard_2 < references/dataserver/misc/shard.sql
$MYSQL zotero_shard_2 < references/dataserver/misc/triggers.sql

$MYSQL zotero_ids < references/dataserver/misc/ids.sql
```

Seed a first local reference user/library:

```bash
MYSQL='mysql -h mysql -P 3306 -u root -pzotero'

echo "INSERT INTO libraries VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 1);" | $MYSQL zotero_master
echo "INSERT INTO users VALUES (1, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);" | $MYSQL zotero_master
echo "INSERT INTO shardLibraries VALUES (1, 'user', CURRENT_TIMESTAMP, 0);" | $MYSQL zotero_shard_1
```

Seed WWW/auth tables using the old self-hosting `www.sql` until a current
official equivalent is identified:

```bash
$MYSQL zotero_www < references/zotero-selfhost/config/dataserver-scripts/www.sql
echo "INSERT INTO users VALUES (1, 'admin', MD5('admin'), 'normal');" | $MYSQL zotero_www
echo "INSERT INTO users_email (userID, email) VALUES (1, 'admin@zotero.local');" | $MYSQL zotero_www
```

## Object storage setup

Create these MinIO buckets before running file tests:

```text
zotero-reference-files
zotero-reference-fulltext
```

The official file tests use the configured `s3Bucket` to clean up and inspect
objects. The candidate Worker does not need this, but the official PHP reference
target does.

## Remote test config

The JavaScript remote tests live here:

```text
references/dataserver/tests/remote/
```

Default config keys are in:

```text
references/dataserver/tests/remote/config/default.json
```

Create a local test config at:

```text
references/dataserver/tests/remote/config/local.json
```

Minimum config for the local reference target:

```json
{
  "verbose": 1,
  "apiURLPrefix": "http://localhost:8080/",
  "rootUsername": "admin",
  "rootPassword": "admin",
  "awsRegion": "us-east-1",
  "s3Bucket": "zotero-reference-files",
  "awsAccessKeyID": "zotero",
  "awsSecretAccessKey": "zoterodocker",
  "userID": 1,
  "libraryID": 1,
  "username": "admin",
  "displayName": "Admin",
  "password": "admin",
  "emailPrimary": "admin@zotero.local",
  "userID2": 2,
  "username2": "phpunit2",
  "displayName2": "Real Name 2",
  "password2": "admin"
}
```

Install remote test dependencies once:

```bash
cd references/dataserver/tests/remote
npm install
```

Run a tiny reference smoke slice:

```bash
cd references/dataserver/tests/remote
./run_tests -v 3 general
```

Run file-specific reference behavior after object storage is confirmed:

```bash
cd references/dataserver/tests/remote
./run_tests -v 3 file
```

## Candidate comparison commands

This repo already has a compatibility harness that points the same remote tests
at reference and candidate targets:

```bash
bun compatibility/run-zotero-tests.ts --target reference -- -v 3 general
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 general
```

Partial file upload comparison target:

```bash
bun compatibility/run-zotero-tests.ts --target reference -- -v 3 file
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 file
```

## Current status

Written from source inspection only. Not yet validated in this repo:

- PHP app container build.
- MySQL reset script against a live local MySQL service.
- MinIO bucket compatibility with official PHP S3 calls.
- Official remote JS tests against the local PHP reference target.
- Candidate partial-upload tests against the Worker.
