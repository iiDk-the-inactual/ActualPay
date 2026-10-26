#!/bin/sh
# Runs once, on the first start of an empty data directory. Creates the two
# application roles and the database; passwords come from Docker secrets.
set -eu
OWNER_PW="$(cat /run/secrets/database_owner_password)"
APP_PW="$(cat /run/secrets/database_app_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" <<'SQL'
CREATE ROLE actualpay_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE actualpay_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE actualpay OWNER actualpay_owner;
SQL
