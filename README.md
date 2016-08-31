Browsing jEdit Trackers with kinto.js: An experiment
====================================================

# 1. What I wanted to achieve

**Access the jEdit sourceforge bug trackers while I'm off the internet.**

It's been solved before, using dumps from Sourceforge:
http://jedit.org/trackers/ provides a downloadable archive of html+a little js
to make browsing more convenient (it's also browsable online).

The problem for me is I have to remember to run the update script (has my
sourceforge credentials) every week or so (the dumps are taking minutes to
generate, so I don't run it so often).

The problem for users is they have to re-download the whole archive each
time (i.e. no auto-update).

**Try out Kinto**

It seems interesting:
 - [kinto](http://kinto.readthedocs.io/en/latest/) has a clean API;
 - it has learned from couchDB;
 - [kinto.js](http://kintojs.readthedocs.io/en/latest/) taps into the browsers' indexedDB and lets you synchronize with the
 server's database;
 - each user may create his collections/records, opening an application for extensions, as well as define fine grained
 permissions.


# 2. What I have

## Server

A kinto server is running at http://kinto.elelay.fr. I'm still in the process of setting it up.
It's running in docker behind an nginx proxy.

I've followed [the permission tutorial](http://kinto.readthedocs.io/en/stable/tutorials/permissions.html) to make
2 read-only collections in the `jedit-trackers` bucket (`tickets` and `oldTickets`).

## Client

A working application is at http://trackers.elelay.fr/trackers.html

It will let you download and browse tickets in a table.

Search is done by a combination of quick filters and full text search:
 - one of
	 - open tickets in different trackers
	 - missed (open tickets without answer older than 2 weeks)
	 - all (include old tickets in the query)
 - combined with full-text-search in summary and description

A result can be expanded, or opened (in a new tab using middle-mouse-button click). One can jump to Sourceforge to edit
the ticket.

Search queries are bookmarkable, thanks to an ugly encoding of the state object in the hash. Tickets are also
bookmarkable and a bit prettier (id in the hash).

It polls the Kinto server for updates every minute, and will prompt you to update when tickets are updated.

Counters and the full-text-search index are saved in a local `stats` collection.

It uses
 - jQuery [Datatables](https://datatables.net/)
 - lodash, moment
 - bootstrap's CSS, fontawesome icons
 - the [lunr](http://lunrjs.com/) package for client-side full-text search

It doesn't use any particular client framework, and the code grew organically to just under 1k lines.

## Updates

I'll run `updater.py` on the kinto server, polling every 5 minutes for changes in Sourceforge trackers.

# 3. Improvements

I want to let users write to tickets: ATM they simply fetch a read-only DB, and kinto can do more. Maybe not write to
the tickets per se, but maintain a user collection with stars, tags, etc..

I initially wanted to apply changes in Sourceforge from forms in the application, using the
 [REST API](https://anypoint.mulesoft.com/apiplatform/sourceforge/#/portals/organizations/98f11a03-7ec0-4a34-b001-c1ca0e0c45b1/apis/32951/versions/34322)
and XMLHTTPRequests. But it's a lot of work to create forms and the like.

I envisioned these changes would be stored in a separate collection and applied when network would be available. The
user would have to login using Sourceforge's [oauth flow](https://sourceforge.net/p/forge/documentation/Allura%20API/?version=20).
Apparently it's not a good idea to do it client side because the application secret token is leaked to everybody.
Maybe use the bearer token for now.

The interface is not ugly (I think), but feels clunky.

Picking a client-side framework (angular-js, react) would help me organise the code but I wanted to be close to vanilla.

**Attachments**: who doesn't like attachments? I've not had time to look into kinto's attachments, but it's on my todo.
Until that, the offline experience may be a bit unperfect: you find an interesting bug to work on, browse the
discussion, stumble upon the inevitable "please upload the activity.log", see the OP has provided it, but the link
doesn't work, because you're off the internet :-(
So I'll try to fetch all attachments and put them in the kinto server. I have no idea of their size yet...

I'm not using lunr.js to it's full potential by indexing so little fields. The index is already a very demanding JSON blob to
load and save. I'm in two minds about that: expand the index by feeding it everything, enabling
[richer queries](https://github.com/olivernn/lunr.js/issues/125) or find another way to do full-text search.

Indexes are not available yet. They could help make some queries quicker (like missed tickets). I'm considering saving
indexes myself in the stats collection (for instance a document with all ticket ids by num).

Full-text indexing is a good fit for a webworker. I'll have to look into that...
