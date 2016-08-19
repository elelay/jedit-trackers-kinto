String.prototype.startsWith = String.prototype.startsWith || function(x) {
    return this.indexOf(x) === 0;
};

const thenLog = console.log.bind(console);
var db, stats, tickets;

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
    stats = db.collection("stats", {
        idSchema: nopSchema
    });

    var state;
    
    function defaultState(){
    	return {
			sort: [{
				field: "ticket_num",
				as: "num",
				order: "+"
			}],
			filter: "",
			activeCounters: {}
		};
    }

    function encodeState(state) {
        return "#" + encodeURIComponent(JSON.stringify(state));
    }

    function applySort(state) {
        _.each(getTicketDisplayFields(), function(th) {
            th.dataset.order = "";
        });
        _.each(state.sort, function(sort) {
        		console.log("apply", sort);
            var head = document.querySelector("#tickets thead *[data-field = '" + sort.field + "']");
            head.dataset.order = sort.order;
        });
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
        applySort(state);
        applyCounters(state);
        applyFilter(state);
        search();
    }

    function saveState(state) {
        window.history.pushState(state, "jEdit Trackers", encodeState(state));
    }

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
            results = tickets.list({
                filters: {
                    ticket_num: parseInt(filter.substring(1))
                }
            }).then(function(res) {
                return res.data.filter(filterByTrackers(activeTrackers));
            });
        } else {
            results = tickets.list()
                .then(function(res) {
                    console.log(res.data[0]);
                    // Filter tickets according to their summary
                    var match = res.data.filter(filterByTrackers(activeTrackers)).filter(filterBySummary(filter));
                    console.log("match", filter, match.length);
                    return match;
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

    function handleConflicts(conflicts) {
        return Promise.all(conflicts.map(function(conflict) {
                return tickets.resolve(conflict, conflict.remote);
            }))
            .then(function() {
                tickets.sync(syncOptions);
            });
    }

    document.getElementById("sync")
        .addEventListener("click", function(event) {
            event.preventDefault();
            tickets.sync(syncOptions)
                .then(function(res) {
                    document.getElementById("results").value = JSON.stringify(res, null, 2);
                    if (res.conflicts.length) {
                        return handleConflicts(res.conflicts);
                    } else {
                        return index();
                    }
                    return res;
                })
                .catch(function(err) {
                    console.error(err);
                });
        });

    function getTicketDisplayFields() {
        return document.querySelectorAll("#tickets thead th[data-field]");
    }

    function getSortFunction(useDataset) {
        var sortFields = _.map(getTicketDisplayFields(), function(th) {
            var field = th.dataset.field;
            var order = th.dataset.order;
            var as = th.dataset.orderAs;
            console.log("sort", field, order, useDataset ? "dataset" : "");
            var getVal;
            if (as === "num") {
                getVal = useDataset ? function(t) {
                    return parseFloat(t.dataset[field]);
                } : function(t) {
                    return parseFloat(t[field]);
                };
            } else {
                getVal = useDataset ? function(t) {
                    return t.dataset[field];
                } : function(t) {
                    return t[field];
                };
            }
            if (order === "+") {
                return function(t1, t2) {
                    var v1 = getVal(t1),
                        v2 = getVal(t2);
                    return (v1 > v2) ? 1 : ((v1 === v2) ? 0 : -1);
                };
            } else if (order === "-") {
                return function(t1, t2) {
                    var v1 = getVal(t1),
                        v2 = getVal(t2);
                    return (v1 > v2) ? -1 : ((v1 === v2) ? 0 : 1);
                };
            } else {
                return function() {
                    return 0;
                };
            }
        });
        return function(t1, t2) {
            return sortFields.reduce(function(acc, sortF) {
                if (acc !== 0) {
                    return acc;
                }
                var cmp = sortF(t1, t2);
                if (cmp === -1 || cmp === 1) {
                    return cmp;
                }
                return acc;
            }, 0);
        };
    }

    function sortTickets() {
        var body = document.getElementById("tickets-body");
        var tickets = _.map(document.querySelectorAll("#tickets-body tr"), function(tr) {
            return body.removeChild(tr);
        });
        tickets.sort(getSortFunction(true));
        console.log(tickets);
        tickets.forEach(function(ticket) {
            body.appendChild(ticket);
        });
    }


    function renderTicket(ticket) {
        var tpl = document.getElementById("ticket-tpl");
        var clone = tpl.content.cloneNode(true);
        var tr = clone.children[0];
        _.each(clone.querySelectorAll("tr > *[data-field]"), function(cell) {
            var field = cell.dataset.field;
            var value = ticket[field] || "";
            cell.textContent = value;
            tr.dataset[field] = value;
        });
        return clone;
    }

    function renderTickets(tickets) {
        var tbody = document.getElementById("tickets-body");
        tbody.innerHTML = "";
        tickets.sort(getSortFunction(false)).forEach(function(ticket) {
            tbody.appendChild(renderTicket(ticket));
        });
    }

    function render(tickets) {
        console.log("render", tickets);
        document.getElementById("match-count").textContent = tickets.length;
        document.getElementById("match-count-p").classList.remove("hidden");
        if (tickets) {
            renderTickets(tickets);
        }
    }

    function computeCounters() {
        return tickets.list().then(function(res) {
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
            return counters;
        });
    }

    function storeCounters(counters) {
        return stats.upsert({
            id: "counters",
            data: counters
        });
    }

    function getCounters() {
        return stats.get("counters").then(function(res) {
            console.log("cc", res);
            return res && res.data && res.data.data;
        });
    }


    function index()  {
        computeCounters().then(storeCounters).then(function() {
            console.log("Updated counters");
        });
    }

    getMissed().then(function(missed) {
        document.getElementById("missed-count").textContent = missed.length;
    });

    function getCounterButtons() {
        return document.querySelectorAll("#open-counters .btn");
    }

    _.each(getCounterButtons(), function(btn) {
        btn.addEventListener("click", function(e) {
            var active = e.target.classList.toggle("active");
            if(active){
            	state.activeCounters[btn.dataset.tracker] = true;
            }else{
            	delete state.activeCounters[btn.dataset.tracker];
            }
            saveState(state);
            search();
        });
    });

    function refreshCounters() {
        getCounters().catch(function(e) {
            console.debug("counters not found, indexing", e);
            index();
        }).then(function(counters) {
            console.log("counters", counters);
            _.each(getCounterButtons(), function(btn) {
                var tracker = btn.dataset.tracker;
                btn.querySelector(".count").textContent = (counters[tracker] && counters[tracker].open) || 0;
            });
        });
    }

    refreshCounters();


    _.map(getTicketDisplayFields(), function(th) {
        th.addEventListener("click", function(event) {
            var order = th.dataset.order;
            if (order === "+") {
                order = "-";
            } else if (order === "-") {
                order = "";
            } else {
                order = "+";
            }
            th.dataset.order = order;
            sortTickets();
        });
    });

    document.getElementById("clear-sorting").addEventListener("click", function() {
        _.each(getTicketDisplayFields(), function(th) {
            th.dataset.order = "";
            state.sort = [];
            saveState(state);
        });
    });

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

    window.addEventListener("popstate", function(e) {
        console.log("popstate", e, e.state);
        if(e.state){
			state = e.state;
		}else{
			state = defaultState();
			console.log("default state", state);
			applyState(state);
		}
    });

}

window.addEventListener("DOMContentLoaded", main);
