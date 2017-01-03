"use strict";

const fs = require("fs");
const request = require("request");
const server = "https://kinto.elelay.fr";
const bucket = "jedit-trackers";
//request.debug = true;

const usage = "Usage: " + process.argv[0] + " " + process.argv[1] + " <JEDIT_EXPORT_DIR> <TOKEN>";

if (process.argv.length != 4 || process.argv[2].match(/--?h(elp)?/)) {
    console.log(usage);
    process.exit(-1);
}

const exportDir = process.argv[2];
const token = process.argv[3];

function load(file) {
    file = exportDir + "/" + file;
    return new Promise(function(resolve, reject) {
        fs.readFile(file, "utf8", function(err, json) {
            if (err) {
                console.log("E: reading", file, err);
                reject(err);
            } else {
                console.log("D: loaded", file);
                try {
                    var obj = JSON.parse(json);
                    resolve(obj);
                } catch (e) {
                    console.log("E: parsing", file, e);
                    reject(e);
                }
            }
        });
    });
}

function transformOne(tracker) {
    //console.log(tracker.tracker_config);
    const trackerId = tracker.tracker_config.options.mount_point;
    const label = tracker.tracker_config.options.mount_label;
    //console.log(tracker.tickets[0]);
    return tracker.tickets.map(function(ticket) {
        ticket.id = ticket._id;
        delete ticket._id;
        ticket.tracker_id = trackerId;
        ticket.tracker_label = label;

        //delete ticket.description;
        //delete ticket.discussion_thread;
        return ticket;
    });
}

function transformAndSave(objs) {
    var inserts = []
    objs.forEach(function(obj) {
        var tickets = transformOne(obj);
        Array.prototype.push.apply(inserts, i);
    });

    var res = {
        "defaults": {
            "method": "POST",
            "path": "/buckets/" + bucket + "/collections/tickets/records",
        }
    };
    res.requests = inserts;
    return save(res);
}

function split(arr, test) {
    return arr.reduce(function(acc, item) {
        (test(item) ? acc[0] : acc[1]).push(item);
        return acc;
    }, [
        [],
        []
    ]);
}

function countAttchmts(obj) {
    var total = obj.attachments.reduce(function(acc, attach) {
        return acc + attach.bytes;
    }, 0);
    if (obj.discussion_thread && obj.discussion_thread.posts) {
        total += obj.discussion_thread.posts.reduce(function(acc, post) {
            return acc + countAttchmts(post);
        }, 0);
    }
    return total;
}

function transformAndCountAttchmnts(objs) {
    objs.slice(0, 1).forEach(function(obj) {
        var tickets = transformOne(obj);
        var splitTickets = split(tickets, function(ticket) {
            const open = (ticket.status.indexOf("open") === 0) || (ticket.status.indexOf("pending") === 0);
            const thisYear = (ticket.created_date.indexOf("2016") === 0) ||
                (ticket.mod_date.indexOf("2016") === 0);
            return open || thisYear;
        });


        const assign = {
            tickets: splitTickets[0],
            oldTickets: splitTickets[1]
        };

        Object.keys(assign).forEach(function(collection) {
            var tickets = assign[collection];
            if (tickets.length) {
                const total = tickets.reduce(function(acc, ticket) {
                    return acc + countAttchmts(ticket);
                }, 0);
                console.log(collection, "attachments:", total);
            }
        });
    });
    return Promise.resolve("OK");
}

var stats = {};
var statsCnt = 0;
var statsTotal = 0;
var giveUp = false;

function transformAndPut(objs) {
    var inserts = [ensureBucket()];
    //var ticketIds = {};
    objs./*slice(1,2).*/forEach(function(obj) {
        var tickets = transformOne(obj);
        var splitTickets = split(tickets, function(ticket) {
            const open = (ticket.status.indexOf("open") === 0) || (ticket.status.indexOf("pending") === 0);
            const thisYear = (ticket.created_date.indexOf("2016") === 0) ||
                (ticket.mod_date.indexOf("2016") === 0);
            return open || thisYear;
        });
        //for(var j=0;j<tickets.length;j++){
        //	if(ticketIds[tickets[j].id]){
        //		console.error("E: duplicate id", tickets[j].id);
        //	}else{
        //		ticketIds[tickets[j].id] = tickets[j].tracker_id;
        //	}
        //}

        const assign = {
            tickets: splitTickets[0],
            oldTickets: splitTickets[1]
        };

        //tickets = tickets.slice(0,400);

        statsTotal += tickets.length;

        Object.keys(assign).forEach(function(collection) {
			inserts.push(ensureCollection(collection));
            var tickets = assign[collection];
            if (tickets.length) {
                const tracker = tickets[0] && tickets[0].tracker_label;
                const total = Math.ceil(tickets.length / 200);
                stats[tracker] = [];
                for (var i = 0; i < tickets.length; i += 200) {
                    var toSend = tickets.slice(i, Math.min(i + 200, tickets.length));
                    inserts.push(put(i / 200, ((i / 200) + 1) + "/" + total + "(" + collection + ")", collection, toSend));
                    stats[tracker].push("-");
                }
            }
        });
    });
    console.log("THERE ARE", statsTotal, "TICKETS");
    setInterval(function() {
        console.log("=================================");
        console.log(statsCnt + "/" + statsTotal, "transferred");
        Object.keys(stats).forEach(function(tracker) {
            console.log(tracker, stats[tracker].join(""));
        });
        console.log("=================================");
        if (statsCnt === statsTotal) {
            process.exit(0);
        } else if(giveUp){
        	process.exit(1);
        }
    }, 5000);

    //return Promise.resolve("OK");
    //return Promise.all(inserts);
    return serialize(inserts);
}

function serialize(promises) {
    if (promises.length) {
        var promise = promises.shift();
        return promise().then(function() {
            serialize(promises);
        }).catch(function(e){
        	console.error("E: " + e);
        	giveUp = true;
        });
    } else {
        return Promise.resolve("OK");
    }
}

function put(i, label, collection, tickets) {
    if (tickets.length > 0) {
        var batch = {
            "defaults": {
                "method": "POST",
                "path": "/buckets/" + bucket + "/collections/" + collection + "/records",
            }
        };
        batch.requests = tickets.map(function(ticket) {
            return {
                body: {
                    data: ticket
                }
            };
        });
        return function() {
            return new Promise(function(resolve, reject) {
                console.log("D: batch posting", tickets.length, "tickets for", tickets[0].tracker_label, label);
                var req = {
                    method: "POST",
                    uri: server + "/v1/batch",
                    auth: {
                        user: "token",
                        pass: token
                    },
                    body: batch,
                    json: true
                };
                //console.log(JSON.stringify(batch));
                request(req, function(err, res, body) {
                    if (err) {
                        reject(err);
                    } else {
                        const tracker = tickets[0].tracker_label;
                        console.log("D: status posting", tickets.length, "tickets for", tracker, label, "=", res.statusCode);
                        statsCnt += tickets.length;
                        if (res.statusCode !== 200) {
                            console.log("E: sending tickets, status=" + res.statusCode + ", body=" + JSON.stringify(body));
                            stats[tracker][i] = "!";
                            reject(new Error("E: sending tickets, status=" + res.statusCode + ", body=" + JSON.stringify(body)));
                        } else {
                            body.responses.forEach(function(rep) {
                                if (rep.status != 200 && rep.status != 201) {
                                    console.error("E: sub req", rep);
                                    stats[tracker][i] = "!";
                                    reject(rep);
                                }
                            });
                            stats[tracker][i] = "+";
                            resolve(res);
                        }
                    }
                });
            });
        };
    }
}

function ensureBucket() {
return function() {
return new Promise(function(resolve, reject) {
	var uriBase = server + "/v1/buckets";
	console.log("D: ensuring bucket", bucket, "exists");
	request({
			method: "GET",
			uri: uriBase + "/" + bucket,
			auth: {
				user: "token",
				pass: token
			}
		}, function(err, response) {
			if(!err) {
				if(response.statusCode == 200) {
					resolve();
				} else if((response.statusCode == 404) || (response.statusCode == 403)) {
					var req = {
						method: "POST",
						uri: uriBase,
						auth: {
							user: "token",
							pass: token
						},
						body: {
							data: {
								id: bucket
							},
							permissions: {
								read: ["system.Everyone"]
							}
						},
						json: true
					};
					request(req, function(err, res, body) {
							if (err) {
								reject(err);
							} else {
								console.log("D: status ensuring bucket", bucket, "=", res.statusCode);
								if (res.statusCode == 201) {
									resolve();
								} else {
									reject("failed crearing bucket: " + res.statusCode);
								}
							}
					});
				} else {
					reject("retrieving " + uri + ": code: "+ response.statusCode);
				}
			} else {
				reject(err);
			}
	});
});
};
}

function ensureCollection(collection) {
return function() {
return new Promise(function(resolve, reject) {
	var uriBase = server + "/v1/buckets/" + bucket + "/collections";
	console.log("D: ensuring collection", collection, "exists in bucket", bucket);
	request({
			method: "GET",
			uri: uriBase + "/" + collection,
			auth: {
				user: "token",
				pass: token
			}
		}, function(err, response) {
			if(!err) {
				if(response.statusCode == 200) {
					resolve();
				} else if(response.statusCode == 404) {
					var req = {
						method: "POST",
						uri: uriBase,
						auth: {
							user: "token",
							pass: token
						},
						body: {
							data: {
								id: collection
							},
							permissions: {
								read: ["system.Everyone"]
							}
						},
						json: true
					};
					request(req, function(err, res, body) {
							if (err) {
								reject(err);
							} else {
								console.log("D: status ensuring collection", collection, "=", res.statusCode);
								if (res.statusCode == 201) {
									resolve();
								} else {
									reject("failed creating collection " + collection + ": " + res.statusCode);
								}
							}
					});
				} else {
					reject("retrieving " + uri + ": code: "+ response.statusCode);
				}
			} else {
				reject(err);
			}
	});
});
};
}

function save(res) {
    return new Promise(function(resolve, reject) {
        fs.writeFile(resultFile, JSON.stringify(res), "utf8", function(err) {
            if (err) {
                console.error("E: saving to", resultFile, err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

fs.readdir(exportDir, function(err, files) {
    console.log("D: Reading " + exportDir);
    if (err) {
        console.error("E: Reading " + exportDir + ": " + err);
        process.exit(-1);
    } else {
        Promise.all(files.map(load)).then(transformAndPut).catch(function(err) {
            console.error("E: ", err);
        });
    }
});
