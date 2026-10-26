Grand Tour music

The music comes in songs. A song is a MIDI file per view, named <song>.<view>.mid:

  expressway.garage.mid      the Garage (showroom)
  expressway.covers.mid      Covers
  expressway.spotlight.mid   Spotlight
  expressway.list.mid        List

Each time Vellum starts, Grand Tour picks one song and plays only its files until Vellum
closes. With more than one song here, a new launch picks a different song from the last one.
A view the song has no file for is silent.

To add a song, put its files here under a new name (midnight.garage.mid, midnight.covers.mid
...). Switching views changes the music on the next beat of the track that is playing, and the
new track picks up at the same point: the same beat for tracks of the same length (write a
song's tracks as variations of one piece), else the same share of the way through.

Grand Tour ships with six songs, "expressway", "lounge", "nightdrive", "pace", "strike" and
"truism", and GeneralUser GS v2.0.3 by S. Christian Collins as the instruments (see LICENSE.txt). Every song uses the instruments from
the first .sf2, .sf3 or .dls file in this folder. Replace any of it with your own.

The music waits for the PRESS ANY BUTTON title screen and follows Settings > General > Sound.
