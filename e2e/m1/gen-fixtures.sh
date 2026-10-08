#!/usr/bin/env bash
# Generate tiny but valid media files for the M1 validation scenarios.
# Requires ffmpeg. Idempotent — existing files are kept.
#
# 11 min runtime: Sonarr/Radarr's sample detection compares a file's runtime
# against the title's expected runtime (10 min minimum for movies / 60-min
# shows), so short clips would never exercise the real import path. The
# picture is low-res to keep the files small — quality comes from the name.
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
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=640x360:rate=6" \
    -f lavfi -i "sine=frequency=440:sample_rate=44100" \
    -t 660 -c:v libx264 -preset ultrafast -crf 36 -pix_fmt yuv420p \
    -c:a aac -b:a 32k -shortest "$out"
  echo "  + $1"
}

# movie — add + duplicate (import-only)
clip "Dune (2021)/Dune.2021.1080p.BluRay.x264-GRP.mkv"

# tv — season pack (monitored seasons)
clip "Severance S01 1080p/Severance.S01E01.1080p.WEB-DL.x264-GRP.mkv"
clip "Severance S01 1080p/Severance.S01E02.1080p.WEB-DL.x264-GRP.mkv"
clip "Severance S01 1080p/Severance.S01E03.1080p.WEB-DL.x264-GRP.mkv"

# anime — absolute numbering
clip "Edgerunners/Cyberpunk Edgerunners - 01.mkv"
clip "Edgerunners/Cyberpunk Edgerunners - 02.mkv"
clip "Edgerunners/Cyberpunk Edgerunners - 03.mkv"

# rejections — valid episodes next to one the *arr must reject (S01E99 doesn't exist)
clip "Andor S01 1080p/Andor.S01E01.1080p.WEB-DL.x264-GRP.mkv"
clip "Andor S01 1080p/Andor.S01E02.1080p.WEB-DL.x264-GRP.mkv"
clip "Andor S01 1080p/Andor.S01E99.1080p.WEB-DL.x264-GRP.mkv"

# copy mode — staged files must survive a copy import
clip "Parasite (2019)/Parasite.2019.1080p.BluRay.x264-GRP.mkv"

echo "fixtures ready in $target"
