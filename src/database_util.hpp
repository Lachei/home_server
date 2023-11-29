#pragma once
#include "Database.hpp"
#include "nlohmann/json.hpp"

static constexpr std::string_view event_table_name = "events";

static void setup_event_table(Database& database);

// returns a json of the following form
// {result: Event, error: String}
// If error exists there was an error with creating the 
// The returned event has an added id field
static nlohmann::json add_event(Database& db, const nlohmann::json& event);
