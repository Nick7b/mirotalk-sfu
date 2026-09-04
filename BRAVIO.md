# What this fork changes, and why

A fork of [miroslavpejic85/mirotalksfu](https://github.com/miroslavpejic85/mirotalksfu), used by
the Bravio cockpit for team and client meetings. **AGPLv3, like the original**, which is why this
repository is public: the changes below run as a network service, and section 13 says the people
using it are owed the source.

Forked from upstream `30e9d4b8`, version 2.4.30, on 4 September 2026.

Every change is marked `bravio:` in a comment where it sits, and all of them are **off by default**
so that with no new environment variables this behaves exactly like upstream.

## The problem it solves

Upstream records in the participant's browser and makes "server recording" a per-browser setting
(`rec_server` in localStorage) that each person has to find and switch on. On a fresh browser it is
off, so the recording is buffered in the tab and only assembled into a download when the person
presses stop.

Measured on 4 September 2026 on a real two minute meeting: the host recorded, left without pressing
stop, was warned but given no way to cancel the leave, and **the recording was lost entirely**. Not
on the server, not on their own machine. That is the failure this fork exists to remove.

## The changes

**`RECORDING_FORCE=true`** makes server recording the only mode. The per-browser setting stops
getting a vote and the switch is hidden rather than left visible in a state nobody may change. The
client then uploads each chunk as it is produced and keeps nothing locally, so an abrupt leave
still leaves a playable file on the server: `/recSync` appends, so what arrived is what you keep.

**`RECORDING_AUTO_FROM=2`** starts recording once that many people are in the room and stops below
it. A conversation is worth recording; one person waiting alone is not. The server decides, because
it is the only party that knows the count.

**Leaving stops the recording first**, so the file is finalised rather than abandoned mid-chunk.

## The limit, stated plainly

Capture still happens in the presenter's browser. This SFU has no recorder of its own, so if the
presenter's laptop dies the recording stops there, and what was already uploaded is what survives.
Recording from mediasoup directly with ffmpeg would remove that, and it is a much larger piece of
work than any of the above.

## Keeping up with upstream

```
git fetch upstream && git merge upstream/main
```

Every change is small and none is in the interface, which is where upstream commits ten times in
two days. `git log --oneline upstream/main..main` lists exactly what this fork owns.
