-- ============================================================================
-- StreamVault MySQL schema
--
-- Import via phpMyAdmin: select/create your target database first (the
-- "Import" tab imports into whichever database is currently selected --
-- this file does not create or select a database itself), then run this
-- file. Safe to re-run (CREATE TABLE IF NOT EXISTS) on a fresh database;
-- it will not alter existing tables if they're already present.
--
-- ID strategy: every table uses a BIGINT UNSIGNED AUTO_INCREMENT primary
-- key. The API layer serializes these as strings (e.g. "_id": "42") so the
-- frontend, which already treats every id as an opaque string, needs no
-- changes.
--
-- Table order matters here (foreign keys must reference an existing table),
-- but FOREIGN_KEY_CHECKS is also toggled off during creation as a safety
-- net in case you reorder or re-run pieces of this file individually.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================================
-- users
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                VARCHAR(255)    NOT NULL,
  email               VARCHAR(255)    NOT NULL,
  password            VARCHAR(255)    NOT NULL,           -- bcrypt hash
  role                ENUM('admin','editor','viewer') NOT NULL DEFAULT 'viewer',
  organization        VARCHAR(255)    NOT NULL DEFAULT '',
  two_factor_enabled  TINYINT(1)      NOT NULL DEFAULT 0,
  two_factor_secret   VARCHAR(255)    NULL,
  remember_tokens     JSON            NULL,                -- array of strings
  active              TINYINT(1)      NOT NULL DEFAULT 1,
  last_login          DATETIME        NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================================
-- live_channels
-- ============================================================================
CREATE TABLE IF NOT EXISTS live_channels (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                VARCHAR(255)    NOT NULL,
  slug                VARCHAR(255)    NOT NULL,
  description         TEXT            NOT NULL,
  category            VARCHAR(255)    NOT NULL DEFAULT '',
  poster_path         VARCHAR(1000)   NOT NULL DEFAULT '',
  owner_id            BIGINT UNSIGNED NOT NULL,
  stream_key          VARCHAR(64)     NOT NULL,            -- secret; app layer never SELECTs this by default
  rtmp_app            VARCHAR(100)    NOT NULL DEFAULT 'live',
  is_enabled          TINYINT(1)      NOT NULL DEFAULT 1,
  status              ENUM('offline','starting','live','error') NOT NULL DEFAULT 'offline',
  current_session_id VARCHAR(100)    NULL,
  live_started_at     DATETIME        NULL,
  last_error          TEXT            NOT NULL,
  live_hls_path       VARCHAR(1000)   NOT NULL DEFAULT '',
  record_enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  viewer_count        INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_live_channels_slug (slug),
  UNIQUE KEY uq_live_channels_stream_key (stream_key),
  KEY idx_live_channels_owner (owner_id),
  KEY idx_live_channels_enabled_status (is_enabled, status),
  CONSTRAINT fk_live_channels_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================================
-- videos
-- ============================================================================
CREATE TABLE IF NOT EXISTS videos (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title               VARCHAR(500)    NOT NULL,
  description         TEXT            NOT NULL,
  owner_id            BIGINT UNSIGNED NOT NULL,
  status              ENUM('uploading','processing','encoding','published','failed','draft','archived') NOT NULL DEFAULT 'uploading',

  original_name       VARCHAR(500)    NOT NULL,
  mime_type           VARCHAR(100)    NOT NULL DEFAULT '',
  size_bytes          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration            INT UNSIGNED    NOT NULL DEFAULT 0,
  width               INT UNSIGNED    NOT NULL DEFAULT 0,
  height              INT UNSIGNED    NOT NULL DEFAULT 0,
  fps                 DECIMAL(6,2)    NOT NULL DEFAULT 0,
  codec               VARCHAR(50)     NOT NULL DEFAULT '',
  audio_codec         VARCHAR(50)     NOT NULL DEFAULT '',
  bitrate             INT UNSIGNED    NOT NULL DEFAULT 0,

  original_path       VARCHAR(1000)   NOT NULL DEFAULT '',
  hls_path            VARCHAR(1000)   NOT NULL DEFAULT '',
  thumbnail_path      VARCHAR(1000)   NOT NULL DEFAULT '',
  preview_path        VARCHAR(1000)   NOT NULL DEFAULT '',

  tags                JSON            NULL,                -- array of strings
  folder              VARCHAR(255)    NOT NULL DEFAULT 'root',
  views               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  encoding_log        JSON            NULL,                -- array of log-line strings

  source_type         ENUM('upload','live-recording') NOT NULL DEFAULT 'upload',
  source_channel_id   BIGINT UNSIGNED NULL,

  encoding_job_id     VARCHAR(255)    NULL,
  encoding_progress   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  encoding_stage      VARCHAR(255)    NOT NULL DEFAULT '',
  encoding_error      TEXT            NULL,

  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_videos_owner_status (owner_id, status),
  KEY idx_videos_source_channel (source_channel_id),
  FULLTEXT KEY ft_videos_title (title),
  CONSTRAINT fk_videos_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_videos_source_channel FOREIGN KEY (source_channel_id) REFERENCES live_channels(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================================
-- video_streams -- was Video.streams[] (embedded array) in MongoDB
-- ============================================================================
CREATE TABLE IF NOT EXISTS video_streams (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  video_id      BIGINT UNSIGNED NOT NULL,
  quality       ENUM('360p','480p','720p','1080p','4K') NOT NULL,
  bitrate       INT UNSIGNED    NOT NULL DEFAULT 0,
  path          VARCHAR(1000)   NOT NULL,
  size          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status        ENUM('pending','encoding','done','failed') NOT NULL DEFAULT 'pending',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_video_streams_video (video_id),
  CONSTRAINT fk_video_streams_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================================
-- upload_sessions
-- ============================================================================
CREATE TABLE IF NOT EXISTS upload_sessions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  upload_id       VARCHAR(255)    NOT NULL,
  owner_id        BIGINT UNSIGNED NOT NULL,
  filename        VARCHAR(500)    NOT NULL,
  mime_type       VARCHAR(100)    NOT NULL DEFAULT 'video/mp4',
  total_size      BIGINT UNSIGNED NOT NULL,
  total_chunks    INT UNSIGNED    NOT NULL,
  chunk_size      INT UNSIGNED    NOT NULL DEFAULT 5242880,
  status          ENUM('active','merging','done','error') NOT NULL DEFAULT 'active',
  temp_dir        VARCHAR(1000)   NOT NULL,
  video_id        BIGINT UNSIGNED NULL,
  error_message   TEXT            NULL,
  expires_at      DATETIME        NOT NULL,               -- MongoDB had a TTL index auto-deleting past this;
                                                            -- MySQL has no equivalent, so the app runs a periodic
                                                            -- `DELETE FROM upload_sessions WHERE expires_at < NOW()`
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_upload_sessions_upload_id (upload_id),
  KEY idx_upload_sessions_owner (owner_id),
  KEY idx_upload_sessions_expires (expires_at),
  CONSTRAINT fk_upload_sessions_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_upload_sessions_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================================
-- upload_chunks -- was UploadSession.receivedChunks[] (embedded array) in MongoDB
-- ============================================================================
CREATE TABLE IF NOT EXISTS upload_chunks (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  upload_session_id   BIGINT UNSIGNED NOT NULL,
  chunk_index         INT UNSIGNED    NOT NULL,
  size                BIGINT UNSIGNED NOT NULL,
  hash                VARCHAR(255)    NOT NULL,
  received_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_upload_chunks_session_index (upload_session_id, chunk_index),
  CONSTRAINT fk_upload_chunks_session FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- No seed data is required: the app itself makes the *first* registered
-- user an admin automatically (see server/src/routes/auth.ts), matching
-- the previous MongoDB behaviour exactly.
-- ============================================================================
