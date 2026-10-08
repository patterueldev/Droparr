#!/usr/bin/env bash
# Generate tiny but valid media files for the M1 validation scenarios.
# Requires ffmpeg. Idempotent — existing files are kept.
#
# Usage: gen-fixtures.sh <target-dir>
set -euo pipefail

target="${1:?usage: gen-fixtures.sh <target-dir>}"
mkdir -p "$target"

clip() {
  local out="$target/$1"
  if [ -f "$out" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$out")"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1920x1080:rate=24" \
    -f lavfi -i "sine=frequency=440:sample_rate=44100" \
    -t 2 -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p \
    -c:a aac -b:a 32k -shortest "$out"
  echo "  + $1"
}

# movie — add + duplicate (import-only)
clip "The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264-GRP.mkv"

# tv — season pack (monitored seasons)
clip "Breaking Bad S01 1080p/Breaking.Bad.S01E01.1080p.WEB-DL.x264-GRP.mkv"
clip "Breaking Bad S01 1080p/Breaking.Bad.S01E02.1080p.WEB-DL.x264-GRP.mkv"
clip "Breaking Bad S01 1080p/Breaking.Bad.S01E03.1080p.WEB-DL.x264-GRP.mkv"

# anime — absolute numbering
clip "Frieren/Sousou no Frieren - 01.mkv"
clip "Frieren/Sousou no Frieren - 02.mkv"
clip "Frieren/Sousou no Frieren - 03.mkv"

# rejections — valid episodes next to one the *arr must reject (S01E99 doesn't exist)
clip "Chernobyl S01 1080p/Chernobyl.S01E01.1080p.WEB-DL.x264-GRP.mkv"
clip "Chernobyl S01 1080p/Chernobyl.S01E02.1080p.WEB-DL.x264-GRP.mkv"
clip "Chernobyl S01 1080p/Chernobyl.S01E99.1080p.WEB-DL.x264-GRP.mkv"

# copy mode — staged files must survive a copy import
clip "Interstellar (2014)/Interstellar.2014.1080p.BluRay.x264-GRP.mkv"

echo "fixtures ready in $target"
