#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${DEMO_VIDEO_ROOT:?DEMO_VIDEO_ROOT is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

readonly provider="BtbN/FFmpeg-Builds"
readonly release_tag="autobuild-2026-08-03-14-02"
readonly ffmpeg_version="n7.1.5-12-g1fdbca85aa"
readonly asset="ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz"
readonly expected_bytes="119011268"
readonly expected_sha256="2164fd331d6578dc3c5b0becf9f86bf21d4fbb0424e2bb54240945203560b242"
readonly download_url="https://github.com/BtbN/FFmpeg-Builds/releases/download/${release_tag}/${asset}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "The pinned Archon FFmpeg toolchain supports Linux x86_64 only." >&2
  exit 1
fi
if [[ "${RUNNER_TEMP}" != /* || "${DEMO_VIDEO_ROOT}" != /* ]]; then
  echo "RUNNER_TEMP and DEMO_VIDEO_ROOT must be absolute." >&2
  exit 1
fi

runner_temp_real="$(realpath -e -- "${RUNNER_TEMP}")"
runner_temp_lexical="${RUNNER_TEMP%/}"
if [[ -L "${RUNNER_TEMP}" ]]; then
  echo "RUNNER_TEMP must not be a symbolic link." >&2
  exit 1
fi
github_env_real="$(realpath -e -- "${GITHUB_ENV}")"
case "${github_env_real}" in
  "${runner_temp_real}"/*) ;;
  *)
    echo "GITHUB_ENV must resolve below RUNNER_TEMP." >&2
    exit 1
    ;;
esac
if [[ -L "${GITHUB_ENV}" || ! -f "${GITHUB_ENV}" ]]; then
  echo "GITHUB_ENV must be a regular non-symlink runner file." >&2
  exit 1
fi
case "${DEMO_VIDEO_ROOT}" in
  "${runner_temp_lexical}"/*) ;;
  *)
    echo "DEMO_VIDEO_ROOT must be a lexical RUNNER_TEMP descendant." >&2
    exit 1
    ;;
esac
relative_video_root="${DEMO_VIDEO_ROOT#"${runner_temp_lexical}"/}"
cursor="${runner_temp_lexical}"
IFS='/' read -r -a video_root_parts <<<"${relative_video_root}"
for part in "${video_root_parts[@]}"; do
  if [[ -z "${part}" || "${part}" == "." || "${part}" == ".." ]]; then
    echo "DEMO_VIDEO_ROOT contains an unsafe path component." >&2
    exit 1
  fi
  cursor="${cursor}/${part}"
  if [[ -e "${cursor}" || -L "${cursor}" ]]; then
    if [[ -L "${cursor}" || ! -d "${cursor}" ]]; then
      echo "DEMO_VIDEO_ROOT traverses a non-directory or symbolic link." >&2
      exit 1
    fi
  else
    mkdir -m 0700 -- "${cursor}"
  fi
done
demo_video_root_real="$(realpath -e -- "${DEMO_VIDEO_ROOT}")"
case "${demo_video_root_real}" in
  "${runner_temp_real}"/*) ;;
  *)
    echo "DEMO_VIDEO_ROOT must resolve below RUNNER_TEMP." >&2
    exit 1
    ;;
esac
if [[ -L "${RUNNER_TEMP}" || -L "${DEMO_VIDEO_ROOT}" ]]; then
  echo "Runner video directories must not be symbolic links." >&2
  exit 1
fi

readonly install_parent="${runner_temp_real}/archon-demo-video-toolchain-${expected_sha256}"
readonly toolchain="${install_parent}/toolchain"
readonly archive="${install_parent}/${asset}"
readonly partial_archive="${archive}.partial"
readonly extraction="${install_parent}/extracting"
readonly archive_listing="${install_parent}/archive-entries.txt"
readonly ffmpeg="${toolchain}/bin/ffmpeg"
readonly ffprobe="${toolchain}/bin/ffprobe"
readonly provenance="${demo_video_root_real}/toolchain-provenance.json"
readonly provenance_tmp="${provenance}.partial"

if [[ -e "${install_parent}" || -e "${provenance}" || -L "${provenance}" ]]; then
  echo "Refusing to overwrite existing FFmpeg or provenance material." >&2
  exit 1
fi
mkdir -m 0700 -- "${install_parent}"

cleanup() {
  rm -f -- "${partial_archive}" "${provenance_tmp}" "${archive_listing}"
  rm -rf -- "${extraction}"
}
trap cleanup EXIT

curl \
  --fail \
  --location \
  --proto '=https' \
  --tlsv1.2 \
  --retry 3 \
  --retry-all-errors \
  --connect-timeout 20 \
  --max-time 300 \
  --output "${partial_archive}" \
  "${download_url}"

actual_bytes="$(stat --format='%s' -- "${partial_archive}")"
actual_sha256="$(sha256sum --binary "${partial_archive}" | cut -d ' ' -f 1)"
if [[ "${actual_bytes}" != "${expected_bytes}" ]]; then
  echo "Pinned FFmpeg archive byte count mismatch." >&2
  exit 1
fi
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  echo "Pinned FFmpeg archive SHA-256 mismatch." >&2
  exit 1
fi
mv -- "${partial_archive}" "${archive}"

tar -tJf "${archive}" >"${archive_listing}"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "${archive_listing}"; then
  echo "Pinned FFmpeg archive contains an unsafe path." >&2
  exit 1
fi
mkdir -m 0700 -- "${extraction}"
tar \
  --extract \
  --xz \
  --file "${archive}" \
  --directory "${extraction}" \
  --strip-components=1 \
  --no-same-owner \
  --no-same-permissions
mv -- "${extraction}" "${toolchain}"

if [[ ! -f "${ffmpeg}" || -L "${ffmpeg}" || ! -x "${ffmpeg}" ]]; then
  echo "Pinned archive did not provide a regular executable ffmpeg." >&2
  exit 1
fi
if [[ ! -f "${ffprobe}" || -L "${ffprobe}" || ! -x "${ffprobe}" ]]; then
  echo "Pinned archive did not provide a regular executable ffprobe." >&2
  exit 1
fi

ffmpeg_version_output="$("${ffmpeg}" -version)"
ffprobe_version_output="$("${ffprobe}" -version)"
ffmpeg_version_line="${ffmpeg_version_output%%$'\n'*}"
ffprobe_version_line="${ffprobe_version_output%%$'\n'*}"
if [[ "${ffmpeg_version_line}" != "ffmpeg version ${ffmpeg_version}"* ]]; then
  echo "Installed ffmpeg version does not match the exact pin." >&2
  exit 1
fi
if [[ "${ffprobe_version_line}" != "ffprobe version ${ffmpeg_version}"* ]]; then
  echo "Installed ffprobe version does not match the exact pin." >&2
  exit 1
fi
configuration=""
while IFS= read -r line; do
  if [[ "${line}" == configuration:* ]]; then
    configuration="${line}"
    break
  fi
done <<<"${ffmpeg_version_output}"
if [[ -z "${configuration}" ]]; then
  echo "Pinned ffmpeg did not report its build configuration." >&2
  exit 1
fi
for required_flag in --enable-gpl --enable-libass --enable-libx264; do
  if [[ " ${configuration} " != *" ${required_flag} "* ]]; then
    echo "Pinned ffmpeg lacks ${required_flag}." >&2
    exit 1
  fi
done
encoders_output="$("${ffmpeg}" -hide_banner -encoders 2>/dev/null)"
if ! grep -Eq '^[[:space:]]+A[^[:space:]]*[[:space:]]+aac[[:space:]]' \
  <<<"${encoders_output}"; then
  echo "Pinned ffmpeg lacks the native AAC encoder." >&2
  exit 1
fi
filters_output="$("${ffmpeg}" -hide_banner -filters 2>/dev/null)"
if ! grep -Eq '[[:space:]]subtitles[[:space:]]' <<<"${filters_output}"; then
  echo "Pinned ffmpeg lacks the libass subtitles filter." >&2
  exit 1
fi

ffmpeg_sha256="$(sha256sum --binary "${ffmpeg}" | cut -d ' ' -f 1)"
ffprobe_sha256="$(sha256sum --binary "${ffprobe}" | cut -d ' ' -f 1)"
jq -n \
  --arg schema "archon.demo-video-toolchain" \
  --arg provider "${provider}" \
  --arg release_tag "${release_tag}" \
  --arg ffmpeg_version "${ffmpeg_version}" \
  --arg asset "${asset}" \
  --argjson bytes "${expected_bytes}" \
  --arg archive_sha256 "${expected_sha256}" \
  --arg ffmpeg_sha256 "${ffmpeg_sha256}" \
  --arg ffprobe_sha256 "${ffprobe_sha256}" \
  '{
    schema: $schema,
    version: 1,
    passed: true,
    provider: $provider,
    releaseTag: $release_tag,
    ffmpegVersion: $ffmpeg_version,
    archive: {
      asset: $asset,
      bytes: $bytes,
      sha256: $archive_sha256
    },
    binaries: {
      ffmpegSha256: $ffmpeg_sha256,
      ffprobeSha256: $ffprobe_sha256
    },
    capabilities: {
      gpl: true,
      libass: true,
      libx264: true,
      aac: true
    }
  }' >"${provenance_tmp}"
chmod 0600 -- "${provenance_tmp}"
mv -- "${provenance_tmp}" "${provenance}"

{
  printf 'FFMPEG=%s\n' "${ffmpeg}"
  printf 'FFPROBE=%s\n' "${ffprobe}"
  printf 'ARCHON_FFMPEG_ARCHIVE=%s\n' "${archive}"
} >>"${GITHUB_ENV}"

printf 'Installed and verified pinned Archon FFmpeg %s.\n' "${ffmpeg_version}"
