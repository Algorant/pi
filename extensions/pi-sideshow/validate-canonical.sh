#!/usr/bin/env bash
# Reproducible Sideshow 0.14.0 canonical direct-HTTP smoke test.
set -euo pipefail

base_url=${SIDESHOW_URL:-http://localhost:8228}
log_file=$(mktemp)
pid=""
session_id=""
test_session_id=""
cleanup() {
  # Delete only sessions created by this run. Session deletion also removes the
  # run's posts, comments, retained history, trace, and session-bound assets.
  if [[ -n "$session_id" ]]; then curl -fsS -X DELETE "$base_url/api/sessions/$session_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$test_session_id" ]]; then curl -fsS -X DELETE "$base_url/api/sessions/$test_session_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -f "$log_file"
}
trap cleanup EXIT

if ! curl -fsS "$base_url/api/sessions" >/dev/null 2>&1; then
  sideshow serve --host 127.0.0.1 >"$log_file" 2>&1 & pid=$!
  for _ in $(seq 1 30); do curl -fsS "$base_url/api/sessions" >/dev/null 2>&1 && break || sleep .2; done
fi
curl -fsS "$base_url/api/sessions" >/dev/null
curl -fsS "$base_url/api/version" | jq -e '.current == "0.14.0"' >/dev/null

# The canonical test post is idempotent. Clean it only when this run created it;
# preserve an existing shared test post and session.
test_post=$(curl -fsS -X POST "$base_url/api/test-post" -H 'content-type: application/json' --data '{"agent":"pi-sideshow-smoke"}')
jq -e '.id and .sessionId' <<<"$test_post" >/dev/null
if [[ $(jq -r '.alreadySent // false' <<<"$test_post") != true ]]; then test_session_id=$(jq -r .sessionId <<<"$test_post"); fi
test_post_again=$(curl -fsS -X POST "$base_url/api/test-post" -H 'content-type: application/json' --data '{"agent":"pi-sideshow-smoke"}')
jq -e --arg id "$(jq -r .id <<<"$test_post")" '.id == $id and .alreadySent == true' <<<"$test_post_again" >/dev/null

json=$(curl -fsS -X POST "$base_url/api/posts" -H 'content-type: application/json' \
  --data '{"title":"pi-sideshow canonical smoke","surfaces":[{"kind":"markdown","markdown":"before"}],"agent":"pi-sideshow-smoke","sessionTitle":"canonical smoke disposable"}')
post_id=$(jq -r .id <<<"$json")
session_id=$(jq -r .sessionId <<<"$json")
[[ -n "$post_id" && "$post_id" != null && -n "$session_id" && "$session_id" != null ]]

initial=$(curl -fsS "$base_url/api/posts/$post_id")
initial_surface_id=$(jq -r '.surfaces[0].id' <<<"$initial")
jq -e --arg post "$post_id" --arg surface "$initial_surface_id" \
  '.id == $post and .version == 1 and (.history | length) == 0 and .surfaces[0].index == 0 and .surfaces[0].id == $surface and .surfaces[0].markdown == "before"' <<<"$initial" >/dev/null

updated=$(curl -fsS -X PUT "$base_url/api/posts/$post_id" -H 'content-type: application/json' \
  --data '{"title":"pi-sideshow canonical smoke updated","surfaces":[{"kind":"markdown","markdown":"after"}]}')
jq -e --arg post "$post_id" '.id == $post and .version == 2' <<<"$updated" >/dev/null

# Sideshow 0.14.0's viewer-only endpoint and hydrate mode return compact current
# render metadata. They omit full history and sandboxed bodies, but retain the
# stable surface identity and a bounded retained-version count.
viewer=$(curl -fsS "$base_url/api/posts/$post_id/viewer")
jq -e --arg post "$post_id" --arg surface "$(jq -r '.surfaces[0].id' <<<"$updated")" \
  '.id == $post and .version == 2 and .versionCount == 2 and (has("history") | not) and .surfaces[0].id == $surface and .surfaces[0].kind == "markdown" and (.surfaces[0] | has("markdown") | not)' <<<"$viewer" >/dev/null
hydrated=$(curl -fsS "$base_url/api/sessions/$session_id/posts?hydrate=1")
jq -e --arg post "$post_id" 'any(.[]; .id == $post and .version == 2 and .versionCount == 2 and (has("history") | not) and (.surfaces[0] | has("markdown") | not))' <<<"$hydrated" >/dev/null

# Full GET remains the agent recovery contract. It proves stable post identity,
# current indexed bodies, and retention of the complete prior version.
recovered=$(curl -fsS "$base_url/api/posts/$post_id")
current_surface_id=$(jq -r '.surfaces[0].id' <<<"$recovered")
jq -e --arg post "$post_id" --arg priorSurface "$initial_surface_id" \
  '.id == $post and .version == 2 and .surfaces[0].index == 0 and .surfaces[0].markdown == "after" and (.history | length) == 1 and .history[0].version == 1 and .history[0].surfaces[0].id == $priorSurface and .history[0].surfaces[0].index == 0 and .history[0].surfaces[0].markdown == "before"' <<<"$recovered" >/dev/null

# A list/get/edit sequence is the restart/compaction recovery path. Target the
# stable surface id returned by GET, not a guessed local index.
curl -fsS "$base_url/api/sessions/$session_id/posts" | jq -e --arg post "$post_id" 'any(.[]; .id == $post and .version == 2)' >/dev/null
edited=$(curl -fsS -X PATCH "$base_url/api/posts/$post_id/surfaces/$current_surface_id" -H 'content-type: application/json' --data '{"content":"edited after recovery"}')
jq -e --arg post "$post_id" --arg surface "$current_surface_id" '.id == $post and .version == 3 and .surfaces[0].id == $surface' <<<"$edited" >/dev/null
curl -fsS "$base_url/api/posts/$post_id" | jq -e --arg surface "$current_surface_id" '.version == 3 and .surfaces[0].id == $surface and .surfaces[0].markdown == "edited after recovery" and (.history | length) == 2' >/dev/null

added=$(curl -fsS -X POST "$base_url/api/posts/$post_id/surfaces" -H 'content-type: application/json' \
  --data '{"surface":{"kind":"markdown","markdown":"added"}}')
added_surface_id=$(jq -r '.surfaces[1].id' <<<"$added")
curl -fsS -X PATCH "$base_url/api/posts/$post_id/surfaces/$added_surface_id" -H 'content-type: application/json' \
  --data '{"content":"edited"}' | jq -e --arg sid "$added_surface_id" '.surfaces[1].id == $sid and .surfaces[1].kind == "markdown"' >/dev/null
curl -fsS -X PATCH "$base_url/api/posts/$post_id/surfaces" -H 'content-type: application/json' \
  --data "{\"order\":[\"$added_surface_id\",\"$current_surface_id\"]}" | jq -e '.surfaces[0].id == $sid' --arg sid "$added_surface_id" >/dev/null
curl -fsS -X DELETE "$base_url/api/posts/$post_id/surfaces/$added_surface_id" | jq -e '.surfaces | length == 1' >/dev/null

# The REST comment endpoint uses the documented `surface` target field for a post.
curl -fsS -X POST "$base_url/api/comments" -H 'content-type: application/json' \
  --data "{\"text\":\"canonical smoke reply\",\"surface\":\"$post_id\"}" | jq -e --arg post "$post_id" '.text == "canonical smoke reply" and .postId == $post' >/dev/null
# Assert the reply is attached to this post, without filtering on client-supplied authorship.
curl -fsS "$base_url/api/comments?session=$session_id&surface=$post_id&wait=0" | jq -e --arg post "$post_id" '.comments | type == "array" and any(.[]; .text == "canonical smoke reply" and (.postId == $post or .surface == $post))' >/dev/null
printf 'asset' | curl -fsS -X POST "$base_url/api/assets?session=$session_id&agent=pi-sideshow-smoke&filename=smoke.txt" \
  -H 'content-type: text/plain' --data-binary @- | jq -e '.id and .sessionId' >/dev/null
printf 'canonical Sideshow API smoke: ok (post %s, session %s; cleanup armed)\n' "$post_id" "$session_id"
