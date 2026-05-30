#!/usr/bin/env bash
set -euo pipefail

reset=$'\033[0m'
bold=$'\033[1m'
dim=$'\033[2m'
cyan=$'\033[36m'
blue=$'\033[34m'
green=$'\033[32m'
magenta=$'\033[35m'
yellow=$'\033[33m'

trap 'printf "\033[?25h%s\n" "$reset"' EXIT

hide_cursor() {
  printf "\033[?25l"
}

clear_frame() {
  printf "\033[2J\033[H"
}

sleep_short() {
  sleep "${1:-0.55}"
}

print_header() {
  printf "%s%sLEARN (ALMOST) ANYTHING%s  %sLocal AI tutor for desktop%s\n" "$bold" "$cyan" "$reset" "$dim" "$reset"
  printf "%s--------------------------------------------------------------------------%s\n\n" "$dim" "$reset"
}

type_line() {
  local text="$1"
  local delay="${2:-0.018}"
  local i char
  for ((i = 0; i < ${#text}; i++)); do
    char="${text:i:1}"
    printf "%s" "$char"
    sleep "$delay"
  done
  printf "\n"
}

bar() {
  local label="$1"
  local pct="$2"
  local color="$3"
  local width=28
  local filled=$((pct * width / 100))
  local empty=$((width - filled))
  local i

  printf "%s%-18s%s [" "$bold" "$label" "$reset"
  printf "%s" "$color"
  for ((i = 0; i < filled; i++)); do
    printf "#"
  done
  printf "%s" "$reset"
  for ((i = 0; i < empty; i++)); do
    printf "."
  done
  printf "] %3d%%\n" "$pct"
}

frame_intro() {
  clear_frame
  print_header
  printf "\n\n"
  type_line "Build a course on any subject."
  type_line "Read the first lesson while the rest is still being generated."
  type_line "Practice with widgets, tests, homework review, and lecture audio."
  printf "\n"
  printf "%sRuns locally on macOS and Windows.%s\n" "$green" "$reset"
  printf "%sUses your existing Claude Code or Codex CLI subscription.%s\n" "$green" "$reset"
  sleep_short 1.3
}

frame_topic() {
  clear_frame
  print_header
  printf "%sFrom a topic to a personalized course%s\n\n" "$bold" "$reset"
  printf "%sInput%s\n" "$yellow" "$reset"
  printf "  Topic:  Computer vision for artists\n"
  printf "  Goal:   understand geometry, build small tools, read papers\n"
  printf "  Format: compact course\n\n"
  printf "%sPipeline%s\n" "$yellow" "$reset"
  type_line "  1. Search real syllabi and reputable sources" 0.012
  type_line "  2. Ask only the questions needed to personalize the path" 0.012
  type_line "  3. Save the course locally in SQLite plus course files" 0.012
  sleep_short 1.2
}

frame_generation() {
  clear_frame
  print_header
  printf "%sCourse build%s\n\n" "$bold" "$reset"
  bar "Curriculum" 100 "$green"
  sleep_short 0.25
  bar "First article" 100 "$green"
  sleep_short 0.25
  bar "Diagrams" 82 "$cyan"
  sleep_short 0.25
  bar "Widgets" 76 "$magenta"
  sleep_short 0.25
  bar "Tests" 64 "$yellow"
  sleep_short 0.25
  bar "Homework" 52 "$blue"
  printf "\n"
  printf "%sArticle-first generation:%s start learning before every extra asset is done.\n" "$green" "$reset"
  printf "%sWidget safety pass:%s headless Chrome renders and checks each interactive.\n" "$green" "$reset"
  sleep_short 1.4
}

frame_lesson() {
  clear_frame
  print_header
  printf "%sLesson view%s\n\n" "$bold" "$reset"
  printf "+------------------------------------------------------------------------+\n"
  printf "| Module 02 / Projection and Perspective                                 |\n"
  printf "|------------------------------------------------------------------------|\n"
  printf "| Article      Camera model, rays, vanishing points, worked examples     |\n"
  printf "| Diagram      Mermaid flow of the projection pipeline                   |\n"
  printf "| Interactive  Drag focal length and watch rays update                   |\n"
  printf "| Test         5 comprehension checks, marked section-by-section         |\n"
  printf "+------------------------------------------------------------------------+\n\n"
  type_line "The lesson is readable first. Enhancements arrive in the background." 0.012
  sleep_short 1.25
}

frame_review() {
  clear_frame
  print_header
  printf "%sHomework with agent review%s\n\n" "$bold" "$reset"
  printf "%sLearner submits%s\n" "$yellow" "$reset"
  printf "  perspective-study.jpg\n"
  printf "  notes.md\n\n"
  printf "%sReview returns%s\n" "$yellow" "$reset"
  printf "  severity: important\n"
  printf "  remark: Horizon line shifts between objects; align it before shading.\n"
  printf "  next: Resubmit after correction.\n\n"
  printf "%sLoop:%s submit -> review -> fix -> pass\n" "$green" "$reset"
  sleep_short 1.45
}

frame_audio_catalog() {
  clear_frame
  print_header
  printf "%sBeyond reading%s\n\n" "$bold" "$reset"
  printf "%sAudio%s\n" "$cyan" "$reset"
  printf "  OS TTS is free. Gemini voices are optional and cached by chunk.\n\n"
  printf "%sSharing%s\n" "$cyan" "$reset"
  printf "  Open a course through ngrok straight from the desktop app.\n\n"
  printf "%sCatalog%s\n" "$cyan" "$reset"
  printf "  Browse public .laacourse packages, download, update, or publish.\n"
  sleep_short 1.4
}

frame_stack() {
  clear_frame
  print_header
  printf "%sDeveloper snapshot%s\n\n" "$bold" "$reset"
  printf "  Tauri 2      desktop shell and IPC\n"
  printf "  React 19     course UI, widgets, tests, player\n"
  printf "  Rust         local store, files, app commands\n"
  printf "  Node sidecar Claude and Codex agent backends\n"
  printf "  SQLite       local-first course state\n\n"
  printf "%sRun locally%s\n" "$yellow" "$reset"
  printf "  pnpm install\n"
  printf "  pnpm --dir sidecar install\n"
  printf "  pnpm tauri dev\n"
  sleep_short 1.7
}

frame_final() {
  clear_frame
  print_header
  printf "\n"
  printf "%sPersonalized courses, generated locally.%s\n\n" "$bold" "$reset"
  printf "%sNo per-token backend required.%s Your existing CLI auth does the work.\n" "$green" "$reset"
  printf "%sOpen source for reading and personal use.%s\n\n" "$dim" "$reset"
  printf "github.com/legostin/learn-almost-anything\n"
  sleep_short 3.6
}

hide_cursor
frame_intro
frame_topic
frame_generation
frame_lesson
frame_review
frame_audio_catalog
frame_stack
frame_final
