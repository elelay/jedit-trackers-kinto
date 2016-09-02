String.prototype.startsWith = String.prototype.startsWith || function(x) {
    return this.indexOf(x) === 0;
};
String.prototype.contains = String.prototype.contains || function(x) {
    return this.indexOf(x) >= 0;
};

const thenLog = console.log.bind(console);
var db, stats, tickets, oldTickets;
var table;
var lunrIndex = {};
const nopSchema = {
    generate: function() {
        throw new Error("can't generate keys");
    },
    validate: function(id) {
        return true
    }
};

const server = "https://kinto.elelay.fr";
const bucket = "jedit-trackers";
const token = "helo";

function main() {
    db = new Kinto({
        remote: server + "/v1",
        headers: {
            Authorization: "Basic " + btoa("token:" + token)
        },
        bucket: bucket,
        timeout: 30000
    });
    tickets = db.collection("tickets", {
        idSchema: nopSchema
    });
    oldTickets = db.collection("oldTickets", {
        idSchema: nopSchema
    });
    stats = db.collection("stats", {
        idSchema: nopSchema
    });

    var state;

    function defaultState() {
        return {
            //            sort: [[1,"asc"]],
            filter: "",
            activeCounters: {},
            missed: false,
            all: false
        };
    }

    function encodeState(state) {
        return "#" + encodeURIComponent(JSON.stringify(state));
    }

    function applySort(state) {
        table.order(state.sort).draw();
    }

    function applyCounters(state) {
        _.each(getCounterButtons(), function(btn) {
            btn.classList.toggle("active", Boolean(state.activeCounters[btn.dataset.tracker]));
        });
    }

    function applyFilter(state) {
        document.getElementById("search").value = state.filter;
    }

    function applyAllMissed(state) {
        ["all", "missed"].forEach(function(id) {
            document.getElementById(id).classList.toggle("active", Boolean(state[id]));
        });
    }

    function applyState(state) {
        //applySort(state);
        applyCounters(state);
        applyAllMissed(state);
        applyFilter(state);
        search();
    }

    function saveState(state) {
        window.history.pushState(state, "jEdit Trackers", encodeState(state));
    }


    var fields = _.map(getTicketDisplayFields(), function(th) {
        return {
            data: th.dataset.field
        };
    });
    fields.unshift({
        "className": "details-control",
        "orderable": false,
        "data": null,
        "defaultContent": ""
    });

    table = new $("#tickets").DataTable({
        data: [],
        columns: fields,
        order: [
            [1, 'asc']
        ],
        searching: false,
        paging: false,
        info: false,
        autoWidth: false
    });

    document.getElementById("form")
        .addEventListener("submit", function(event) {
            event.preventDefault();
            state.filter = document.getElementById("search").value;
            saveState(state);
            search();
        });


    document.getElementById("clear")
        .addEventListener("click", function() {
            document.getElementById("search").value = "";
        });

    var syncOptions = {};

    function filterByTrackers(active) {
        if (active && active.length) {
            return function(ticket) {
                return active.includes(ticket.tracker_id);
            }
        } else {
            return function() {
                return true;
            }
        }
    }

    function filterBySummary(filter) {
        return function(ticket) {
            return ticket.summary && (ticket.summary.indexOf(filter) >= 0);
        };
    };

    function searchBySummaryIndex(filter, includeOld) {
        var toSearch = [{
            coll: tickets,
            index: lunrIndex.tickets
        }];
        if (includeOld) {
            toSearch.push({
                coll: oldTickets,
                index: lunrIndex.oldTickets
            });
        }
        return Promise.all(toSearch.map(function(s) {
            if (!s.index) {
                return Promise.resolve({
                    data: []
                });
            } else {
                return Promise.all(s.index.search(filter).map(function(hit) {
                    return s.coll.get(hit.ref);
                })).then(function(allRes) {
                    return {
                        data: allRes.map(function(res) {
                            return res.data;
                        })
                    };
                });
            }
        }));
    }

    function search() {
        var filter = state.filter;
        var activeTrackers = Object.keys(state.activeCounters);
        var all = state.all;
        var missed = state.missed;
        var qTitle = [(filter||"every ticket"), "in", (missed && "MISSED") ||  (all && "ALL") || activeTrackers].join(" ");
        console.log("searching for", qTitle);
        document.title = "jEdit Trackers - " + qTitle;
        var results;
        var includeOld = all && !activeTrackers.length && !missed;

        function emptyRes() {
            return Promise.resolve({
                data: []
            });
        }
        if (!filter && !activeTrackers.length && !all && !missed) {
            results = Promise.resolve([]);
        } else if (filter.match(/^#\d+/)) {
            var byNum = {
                filters: {
                    ticket_num: parseInt(filter.substring(1), 10)
                }
            };

            results = Promise.all([tickets.list(byNum),
                    includeOld ? oldTickets.list(byNum) : emptyRes()
                ])
                .then(function(multiRes) {
                    return _.flatMap(multiRes, function(res) {
                        return res.data.filter(missed ? filterByMissed : filterByTrackers(activeTrackers));
                    });
                });
        } else {
            if (filter) {
                results = searchBySummaryIndex(filter, includeOld).then(function(multiRes) {
                    console.log("searchBySummaryIndex", multiRes);
                    return multiRes;
                });
            } else {
                results = Promise.all([tickets.list(),
                    includeOld ? oldTickets.list() : emptyRes()
                ])
            }
            results = results
                .then(function(multiRes) {
                    return _.flatMap(multiRes, function(res) {
                        var match = res.data.filter(missed ? filterByMissed : filterByTrackers(activeTrackers));
                        console.log("match", filter, match.length);
                        return match;
                    });
                });
        }
        results.then(render)
            .catch(function(err) {
                console.error(err);
            });
    }


    const oldishDate = moment(new Date()).add(-2, "weeks");

    function filterByMissed(ticket) {
        const no_answer = ticket.discussion_thread.posts.length === 0;
        const oldish = moment(ticket.created_date).isSameOrBefore(oldishDate);
        const open = ticket.status === "open";
        return no_answer && oldish;
    }

    function handleConflicts(coll, conflicts) {
        return Promise.all(conflicts.map(function(conflict) {
                return coll.resolve(conflict, conflict.remote);
            }))
            .then(function() {
                coll.sync(syncOptions);
            });
    }

    function synchronize(coll) {
        return coll.sync(syncOptions)
            .then(function(res) {
                // remove details
                var created = res.created;
                var updated = res.updated;
                res.created = res.created.length;
                res.updated = res.updated.length;

                document.getElementById("results").value = document.getElementById("results").value + "\n\n" + JSON.stringify(res, null, 2);
                if (res.conflicts.length) {
                    return handleConflicts(coll, res.conflicts);
                } else {
                    return index(coll, created, updated, res.deleted);
                }
                return res;
            })
            .catch(function(err) {
                console.error(err);
            });
    }

    document.getElementById("sync")
        .addEventListener("click", syncClick);
    document.getElementById("sync-new")
        .addEventListener("click", syncClick);

    function syncClick() {
        console.log("syncClick");

        function enableSync(enabled) {
            _.each(document.querySelectorAll(".sync"), function(btn) {
                if (enabled) {
                    btn.setAttribute("disabled", "disabled");
                } else {
                    btn.removeAttribute("disabled");
                }
            });
        }
        enableSync(false);
        stats.getAny("counters.oldTickets").then(function(res) {
            var sync = [synchronize(tickets)];
            if (res.data) {
                sync.push(synchronize(oldTickets));
            }
            return Promise.all(sync).then(function() {
                document.getElementById("new-msg").classList.add("hidden");
                enableSync(false);
            });
        });
    }

    function getTicketDisplayFields() {
        return document.querySelectorAll("#tickets thead th[data-field]");
    }

    function getValue(obj, path) {
        var step = path.shift();
        var value = obj[step];
        if (path.length) {
            value = value && getValue(value, path);
        }
        return value;
    }

    function getOrComputeValue(obj, field) {
        switch (field) {
            case "__resolution":
                var s = obj["status"] || "";
                return (s.contains("-") && s.substring(s.lastIndexOf("-") + 1)) || "";
            default:
                return getValue(obj, field.split(/\./));
        }
    }

    function fileSize(value) {
        if (value < 1000) {
            return value + "o";
        }
        if (value < 1000000) {
            return _.round(value / 1024, 1) + "Kio";
        }
        return _.round(value / 1024 / 1024, 1) + "Mio";
    }

    function renderFields(clone, obj) {
        _.each(clone.querySelectorAll("*[data-field]"), function(cell) {
            var field = cell.dataset.field;
            var value = getOrComputeValue(obj, field) || "";
            var multi = cell.dataset.ml;
            if (multi) {
                value = value.replace(/\n/g, "<br>");
                cell.innerHTML = value;
            } else {
                cell.textContent = value;
            }
        });
    }

    function renderAttachments(clone, obj) {
        obj.attachments.forEach(function(attach) {
            var p = document.createElement("p");
            var a = document.createElement("a");
            var file = attach.url.substring(attach.url.lastIndexOf("/") + 1);
            var size = fileSize(attach.bytes);
            a.setAttribute("href", attach.url);
            a.textContent = file + " (" + size + ")";
            p.appendChild(a);
            clone.querySelector(".attachments").appendChild(p);
        });
    }


    function renderDiscussion(parent, ticket) {
        if (ticket.discussion_thread.posts.length) {
            var tpl = document.getElementById("ticket-discussion");
            var clone = tpl.content.cloneNode(true);
            var tr = clone.querySelector("tr");
            var posts = _.map(ticket.discussion_thread.posts, function(post) {
                var clone = tr.cloneNode(true);
                renderFields(clone, post);

                renderAttachments(clone, post);

                return clone;
            });
            var tbody = clone.querySelector("tbody");
            tbody.removeChild(tr);
            posts.forEach(function(post) {
                tbody.appendChild(post);
            });

            parent.querySelector(".discussion").appendChild(clone);
            parent.querySelector(".discussion-length").textContent = "(" + ticket.discussion_thread.posts.length + ")";
            parent.querySelector(".toggle-discussion").addEventListener("click", function(e) {
                e.target.classList.toggle("collapsed");
                e.target.parentNode.querySelector(".discussion").classList.toggle("hidden", e.target.classList.contains("collapsed"));
            });
        } else {
            var toggle = parent.querySelector(".toggle-discussion");
            toggle.innerHTML = "No Comment";
            toggle.classList.add("no");
        }
    }

    function renderUrl(clone, ticket) {
        var url = "https://sourceforge.net/p/jedit/" + ticket.tracker_id + "/" + ticket.ticket_num + "/";
        clone.querySelector(".ticket-url").setAttribute("href", url);
        clone.querySelector(".goto-ticket").setAttribute("href", "#" + ticket.id);
    }

    function renderDetails(ticket) {
        console.log("details for", ticket);
        var tpl = document.getElementById("ticket-tpl");
        var clone = tpl.content.cloneNode(true);

        renderFields(clone, ticket);
        renderDiscussion(clone, ticket);
        renderUrl(clone, ticket);

        return clone;
    }

    function renderTickets(tickets) {
        table.rows().remove();
        table.rows.add(tickets).draw();
    }

    function render(tickets) {
        document.getElementById("match-count").textContent = tickets.length;
        document.getElementById("match-count-p").classList.remove("hidden");
        //if (tickets) {
        renderTickets(tickets);
        //}
    }


    $("#tickets-body").on("click", "td.details-control", function() {
        var tr = $(this).closest("tr");
        var row = table.row(tr);

        if (row.child.isShown()) {
            // This row is already open - close it
            row.child.hide();
            tr.removeClass('shown');
        } else {
            // Open this row
            row.child(renderDetails(row.data())).show();
            tr.addClass('shown');
        }
    });

    function merge(obj, upd, subtract) {
        Object.keys(upd).forEach(function(k) {
            if (!(k in obj)) {
                if (_.isObject(upd[k]) && subtract) {
                    throw new Error("trying to remove missing key " + k + " from " + obj);
                } else {
                    obj[k] = _.isObject(upd[k]) ? {} : 0;
                }
            }
        });
        Object.keys(obj).forEach(function(k) {
            if (upd[k]) {
                if (_.isNumber(obj[k])) {
                    if (subtract) {
                        obj[k] -= upd[k];
                    } else {
                        obj[k] += upd[k];
                    }
                } else if (_.isObject(obj[k])) {
                    merge(obj[k], upd[k]);
                } else {
                    throw new Error("merge non Object/Number: " + obj[k] + ": " + typeof obj[k]);
                }
            }
        });
    }

    function computeCountersDelta(res) {
        if (res.deleted.length) {
            // I can't adjust counters when a ticket is deleted: I need the old value
            return res.coll.list().then(function(listRes) {
                res.tickets = res.data;
                return computeCounters(res);
            });
        } else {

            var newCnts = computeCounters({
                tickets: res.created
            });
            var oldCnts = computeCounters({
                tickets: res.updated.map(function(o) {
                    return o.old;
                })
            });
            var updCnts = computeCounters({
                tickets: res.updated.map(function(o) {
                    return o.new;
                })
            });

            merge(res.counters, newCnts.counters);
            merge(res.counters, oldCnts.counters, true);
            merge(res.counters, updCnts.counters);

            return res;
        }
    }

    function computeCounters(res) {
        var counters = {};
        var total = 0;
        var missed = 0;
        res.tickets.forEach(function(ticket) {
            if (!counters[ticket.tracker_id]) {
                counters[ticket.tracker_id] = {};
            }
            var status = ticket.status;
            if (status.indexOf("-") > 0) {
                status = status.substring(0, status.indexOf("-"));
            }
            counters[ticket.tracker_id][status] = (counters[ticket.tracker_id][status] || 0) + 1;
            total++;
            if (filterByMissed(ticket)) missed++;
        });
        counters._total = total;
        counters._missed = missed;
        res.counters = counters;
        return res;
    }

    function storeCounters(res) {
        return stats.upsert({
            id: "counters." + res.coll.name,
            data: res.counters
        }).then(function() {
            return res;
        });
    }

    function getCounters() {
        return stats.get("counters.tickets").then(function(res) {
            console.log("cc", res);
            return res && res.data && res.data.data;
        });
    }

    function getAllCount() {
        return Promise.all(["counters.tickets", "counters.oldTickets"].map(stats.getAny.bind(stats)))
            .then(function(multiRes) {
                return multiRes.reduce(function(acc, res) {
                    acc.total += (res.data && res.data.data._total) || 0;
                    acc.missed += (res.data && res.data.data._missed) || 0;
                    return acc;
                }, {
                    total: 0,
                    missed: 0
                });
            });
    }

    function refreshTotalMissed() {
        return getAllCount().then(function(total) {
            document.getElementById("all-count").textContent = total.total;
            document.getElementById("missed-count").textContent = total.missed;
        });
    }

    //index(tickets);
    //index(oldTickets);

    function index(coll, created, updated, deleted)  {
        console.log("index", created && created.length, updated && updated.length, deleted && deleted.length);
        var list;

        function initList() {
            return coll.list().then(function(res) {
                return {
                    coll: coll,
                    tickets: res.data,
                    compCnt: computeCounters,
                    indx: indexLunr
                };
            });
        }

        if (created) {
            list = stats.get("counters." + coll.name)
                .then(function(cnt) {
                    return {
                        coll: coll,
                        counters: cnt.data.data,
                        created: created,
                        updated: updated,
                        deleted: deleted,
                        compCnt: computeCountersDelta,
                        indx: indexLunrDelta
                    };
                })
                .catch(initList)
        } else {
            list = initList();
        }

        return list.then(function(res) {
            return res.compCnt(res);
        }).then(storeCounters).then(function(res) {
            console.log("Updated counters for", res.coll.name);
            refreshCounters();
            refreshTotalMissed();
            return res;
        }).then(function(res) {
            return res.indx(res);
        }).then(storeLunrIndex).then(function(res) {
            console.log("Updated lunr index for", res.coll.name);
            return res;
        });
    }

    function getCounterButtons() {
        return document.querySelectorAll("#open-counters .btn");
    }

    _.each(getCounterButtons(), function(btn) {
        btn.addEventListener("click", function(e) {
            var active = e.target.classList.toggle("active");
            if (active) {
                state.activeCounters[btn.dataset.tracker] = true;
                delete state.missed;
                delete state.all;
            } else {
                delete state.activeCounters[btn.dataset.tracker];
            }
            saveState(state);
            applyState(state);
        });
    });

    ["all", "missed"].forEach(function(id) {
        document.getElementById(id).addEventListener("click", function(e) {
            var active = e.target.classList.toggle("active");
            if (active) {
                state[id] = true;
                state.activeCounters = {};
                if (id === "missed") {
                    delete state.all;
                } else {
                    delete state.missed;
                }
            } else {
                delete state[id];
            }
            saveState(state);
            applyState(state);
            //search();
        });
    });


    function refreshCounters() {
        getCounters().then(function(counters) {
            console.log("counters", counters);
            _.each(getCounterButtons(), function(btn) {
                var tracker = btn.dataset.tracker;
                btn.querySelector(".count").textContent = (counters[tracker] && counters[tracker].open) || 0;
            });
        });
    }

    function noDBPane() {
            document.getElementById("initial-fetch").setAttribute("disabled", "disabled");
        fetchTicketsCount().then(function([count, oldCount]) {
            document.getElementById("remote-tickets-count").textContent = count;
            document.getElementById("old-tickets-count").textContent = oldCount;
            document.getElementById("initial-fetch").removeAttribute("disabled");
            showSpinner(false);
        });
        document.getElementById("initial-fetch").addEventListener("click", function() {
            const toSync = [synchronize(tickets)];
            if (document.getElementById("include-old").checked) {
                console.log("also fetching old tickets");
                toSync.push(synchronize(oldTickets));
            }
            Promise.all(toSync).then(function() {
                showWithDB(true);
                hasDB();
            });
        });
    }

    function showWithDB(show) {
        _.each(document.querySelectorAll(".with-db, .with-ticket"), function(comp) {
            comp.classList.toggle("hidden", !show);
        });
        _.each(document.querySelectorAll(".without-db"), function(comp) {
            comp.classList.toggle("hidden", show);
        });
        _.each(document.querySelectorAll(".with-ticket"), function(comp) {
            comp.classList.toggle("hidden", true);
        });
    }

    function showWithTicket() {
        _.each(document.querySelectorAll(".with-ticket"), function(comp) {
            comp.classList.toggle("hidden", false);
        });
        _.each(document.querySelectorAll(".without-db, .with-db"), function(comp) {
            comp.classList.toggle("hidden", true);
        });
    }

    function hashIsTicket() {
        return window.location.hash.match(/^#[a-z0-9-]+$/);
    }

    function hasDB() {
        if (hashIsTicket()) {
            showWithTicket(true);
            showTicket(window.location.hash.substring(1)).then(function() {
                showSpinner(false);
            });
        } else {
            showWithDB(true);
            loadLunrIndex().then(function() {
                restoreInitialState();
                refreshCounters();
                refreshTotalMissed().then(function() {
                    showSpinner(false);
                });
                setInterval(function() {
                    fetchNewTickets().then(function(newCounts) {
                        var cnt = _.sum(newCounts);
                        if (cnt) {
                            document.getElementById("new-msg").classList.remove("hidden");
                            document.getElementById("new-count").textContent = cnt;
                        }
                    });
                }, 60000);
            });
        }
    }

    function restoreInitialState() {
        if (history.state) {
            state = history.state;
            console.log("restoring state from history", state);
            applyState(state);
        } else if (window.location.hash.startsWith("#%7B")) {
            try {
                state = JSON.parse(decodeURIComponent(window.location.hash.substring(1)));
            } catch (e) {
                console.log("invalid state in hash", window.location.hash);
                state = defaultState();
            }
            console.log("restoring state from hash", state);
            applyState(state);
        } else {
            state = defaultState();
            console.log("using default state", state);
            applyState(state);
        }
    }

    window.addEventListener("popstate", function(e) {
        console.log("popstate", e, e.state);
        if (e.state) {
            state = e.state;
            applyState(state);
            showWithDB(true);
        } else {
            state = defaultState();
            console.log("default state", state, lunrIndex);
            if (lunrIndex.tickets) {
                hasDB();
            } else {
                init();
            }
        }
    });

    function fetchTotalRecords(api, bucket, name, etag) {
        var headers = {};
        headers["Authorization"] = "Basic " + btoa("token:tr0ub4d@ur");
        return api.client.execute({
            path: "/buckets/" + bucket + "/collections/" + name + "/records" + (etag ? ("?_since=" + etag) : ""),
            method: "HEAD",
            headers
        }, {
            raw: true
        }).then(function(res) {
            console.log("RES", res);
            return parseInt(res.headers.get("total-records"), 10);
        });
    }

    function fetchTicketsCount() {
        return Promise.all([fetchTotalRecords(tickets.api.bucket(tickets.bucket).collection(tickets.collection), tickets.bucket, tickets.name), fetchTotalRecords(tickets.api.bucket(tickets.bucket).collection(tickets.collection), tickets.bucket, "oldTickets")]);
    }

    function showSpinner(show) {
        document.getElementById("loading").classList.toggle("hidden", !show);
    }

    function fetchNewTickets() {
        function fetchTotalIfMod(coll) {
            return coll.db.getLastModified().then(function(lastMod) {
                if (lastMod) return fetchTotalRecords(coll.api.bucket(coll.bucket).collection(coll.name), coll.bucket, coll.name, lastMod);
                else return Promise.resolve(0);
            })
        }
        return Promise.all([
            fetchTotalIfMod(tickets),
            fetchTotalIfMod(oldTickets)
        ]).then(function(multiRes) {
            console.log("fetchNewTickets", multiRes);
            return multiRes;
        });
    }

    function createLunr() {
        return lunr(function() {
            this.field('summary', {
                boost: 10
            })
            this.field('description')
            this.ref('id')
        });
    }

    function indexLunrDelta(res) {
        res.index = lunrIndex[res.coll.name];
        if (res.index) {
            res.created.forEach(function(ticket) {
                res.index.add(ticket);
            });
            res.updated.forEach(function(upd) {
                res.index.update(upd.new);
            });
            res.deleted.forEach(function(ticket) {
                res.index.remove(ticket);
            });
            return res;
        } else {
            if (res.tickets) {
                return indexLunr(res);
            } else {
                return res.coll.list().then(function(listRes) {
                    res.tickets = listRes.data;
                    return indexLunr(res);
                });
            }
        }
    }

    function indexLunr(res) {
        var index = createLunr();
        res.tickets.forEach(function(ticket) {
            index.add(ticket);
        });
        res.index = index;
        lunrIndex[res.coll.name] = index;
        return res;
    }

    function storeLunrIndex(res) {
        return stats.upsert({
            id: "index." + res.coll.name,
            data: JSON.stringify(res.index.toJSON())
        }).then(function() {
            return res;
        });
    }

    function loadLunrIndex() {
        if (lunrIndex["tickets"]) {
            console.log("already loaded", Object.keys(lunrIndex), "LunrIndexes");
            return Promise.resolve(true);
        } else {
            return Promise.all(["index.tickets", "index.oldTickets"].map(stats.getAny.bind(stats)))
                .then(function(multiRes) {
                    multiRes.forEach(function(res) {
                        if (res.data) {
                            var i = createLunr();
                            i = lunr.Index.load(JSON.parse(res.data.data));
                            lunrIndex[res.data.id.substring("index.".length)] = i;
                        }
                    });
                    console.log("loaded", Object.keys(lunrIndex), "LunrIndexes");
                });
        }
    }

    function showTicket(id) {
        console.log("showTicket(", id, ")");
        return tickets.get(id).then(function(res) {
            var ticket = res.data;
            var headText = ticket.ticket_num + " - " + ticket.summary;
            document.title = "jEdit Trackers - " + ticket.tracker_label + " #"+ headText;
            document.getElementById("tracker-label").textContent = ticket.tracker_label;
            var header = document.getElementById("ticket-num");
            header.textContent = headText;
            header.setAttribute("href", "#" + id);
            var contents = renderDetails(ticket);
            document.getElementById("ticket-contents").innerHTML = "";
            document.getElementById("ticket-contents").appendChild(contents);
        }).catch(function() {
            document.getElementById("ticket-not-found").classList.remove("hidden");
            document.getElementById("ticket-not-found").innerHTML = "<p>ticket <b>" + encodeURIComponent(id) + "</b> not found</p>";
        });
    }

    function init() {
        tickets.db.getLastModified().then(function(res) {
            if (res) {
                hasDB();
            } else {
                showWithDB(false);
                stats.clear();
                noDBPane();
            }
        });
    }
    init();

}

window.addEventListener("DOMContentLoaded", main);
