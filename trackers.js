String.prototype.startsWith = String.prototype.startsWith || function(x) {
    return this.indexOf(x) === 0;
};
String.prototype.contains = String.prototype.contains || function(x) {
    return this.indexOf(x) >= 0;
};

const thenLog = console.log.bind(console);
var db, stats, tickets, oldTickets;
var table;
const nopSchema = {
    generate: function() {
        throw new Error("can't generate keys");
    },
    validate: function(id) {
        return true
    }
};

function main() {
    db = new Kinto();
    tickets = db.collection("tickets");
    oldTickets = db.collection("oldTickets");
    stats = db.collection("stats", {
        idSchema: nopSchema
    });

    var state;

    function defaultState() {
        return {
            //        	sort: [[1,"asc"]],
            filter: "",
            activeCounters: {}
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

    function applyState(state) {
        //applySort(state);
        applyCounters(state);
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
    console.log("fields", fields);

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

    document.getElementById("missed")
        .addEventListener("click", function(event) {
            getMissed()
                .then(render)
                .catch(function(err) {
                    console.error(err);
                });
        });

    var syncOptions = {
        remote: "http://localhost:8888/v1",
        headers: {
            Authorization: "Basic " + btoa("token:tr0ub4d@ur")
        }
    };

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

    function search() {
        var filter = state.filter;
        var activeTrackers = _.map(document.querySelectorAll(".counters .btn.active"), function(btn) {
            return btn.dataset.tracker;
        });
        console.log("searching for", filter, "in", activeTrackers);
        var results;
        if (!filter && !activeTrackers.length) {
            results = Promise.resolve([]);
        } else if (filter.match(/^#\d+/)) {
            var byNum = {
                filters: {
                    ticket_num: parseInt(filter.substring(1))
                }
            };

            results = Promise.all([tickets.list(byNum), activeTrackers.length ? Promise.resolve({
                data: []
            }) : oldTickets.list(byNum)]).then(function(multiRes) {
                return _.flatMap(multiRes, function(res) {
                    return res.data.filter(filterByTrackers(activeTrackers));
                });
            });
        } else {
            results = Promise.all([tickets.list(), activeTrackers.length ? Promise.resolve({
                    data: []
                }) : oldTickets.list()])
                .then(function(multiRes) {
                    return _.flatMap(multiRes, function(res) {
                        // Filter tickets according to their summary
                        var match = res.data.filter(filterByTrackers(activeTrackers)).filter(filterBySummary(filter));
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


    function getMissed() {
        return tickets.list({
                filters: {
                    status: "open"
                }
            })
            .then(function(res) {
                console.log(res.data[0]);
                // Filter tickets according to their summary
                var oldishDate = moment(new Date()).add(-2, "weeks");
                var match = res.data.filter(function(ticket) {
                    const no_answer = ticket.discussion_thread.posts.length === 0;
                    const oldish = moment(ticket.created_date).isSameOrBefore(oldishDate);
                    return no_answer && oldish;
                });
                console.log("match missed", match.length);
                return match;
            })
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
                res.created = res.created.length;
                res.updated = res.updated.length;

                document.getElementById("results").value = document.getElementById("results").value + "\n\n" + JSON.stringify(res, null, 2);
                if (res.conflicts.length) {
                    return handleConflicts(coll, res.conflicts);
                } else {
                    return index(coll);
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
        stats.get("counters.oldTickets").then(function(res) {
            var sync = [synchronize(tickets)];
            if (res.data.length) {
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
            parent.querySelector(".discussion").appendChild(clone);
        }
    }

    function renderDetails(ticket) {
        console.log("details for", ticket);
        var tpl = document.getElementById("ticket-tpl");
        var clone = tpl.content.cloneNode(true);

        renderFields(clone, ticket);
        renderDiscussion(clone, ticket);

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


    function computeCounters(coll) {
        return coll.list().then(function(res) {
            var counters = {};
            res.data.forEach(function(ticket) {
                if (!counters[ticket.tracker_id]) {
                    counters[ticket.tracker_id] = {};
                }
                var status = ticket.status;
                if (status.indexOf("-") > 0) {
                    status = status.substring(0, status.indexOf("-"));
                }
                counters[ticket.tracker_id][status] = (counters[ticket.tracker_id][status] || 0) + 1;
            });
            return {
                coll: coll,
                counters: counters
            };
        });
    }

    function storeCounters(counters) {
        return stats.upsert({
            id: "counters." + counters.coll.name,
            data: counters.counters
        });
    }

    function getCounters() {
        return stats.get("counters.tickets").then(function(res) {
            console.log("cc", res);
            return res && res.data && res.data.data;
        });
    }


    function index(coll)  {
        computeCounters(coll).then(storeCounters).then(function() {
            console.log("Updated counters");
            refreshCounters();
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
            } else {
                delete state.activeCounters[btn.dataset.tracker];
            }
            saveState(state);
            search();
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
        _.each(document.querySelectorAll(".with-db"), function(comp) {
            comp.classList.toggle("hidden", !show);
        });
        _.each(document.querySelectorAll(".without-db"), function(comp) {
            comp.classList.toggle("hidden", show);
        });
    }

    function hasDB() {
        restoreInitialState();
        refreshCounters();
        getMissed().then(function(missed) {
            document.getElementById("missed-count").textContent = missed.length;
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
        } else {
            state = defaultState();
            console.log("default state", state);
            applyState(state);
        }
    });

    function fetchTotalRecords(api, bucket, name, etag) {
        var headers = {};
        headers["Authorization"] = "Basic " + btoa("token:tr0ub4d@ur");
        //etag && (headers["If-None-Match"] = "\""+etag+"\"");
        return api.client.execute({
            path: "/buckets/" + bucket + "/collections/" + name + "/records" + (etag ? ("?_since=" + etag) : ""),
            method: "HEAD",
            headers
        }, {
            raw: true
        }).then(function(res) {
            console.log("RES", res);
            return res.headers.get("total-records");
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
        });
    }

    tickets.list().then(function(res) {
        showWithDB(res.data.length);
        if (res.data.length) {
            hasDB();
        } else {
            noDBPane();
        }
    });
}

window.addEventListener("DOMContentLoaded", main);
