#pragma once
#include "Database.hpp"
#include "nlohmann/json.hpp"

namespace database_util
{
    static constexpr std::string_view event_table_name = "events";
    static constexpr std::string_view active_timeclock_table_name = "active_timeclocks";
    static constexpr std::string_view finished_timeclock_table_name = "finished_time_clocks";

    void setup_event_table(Database &database);

    // returns a json of the following form
    // {result: Event, error: String}
    // If error exists there was an error with creating the
    // The returned event has an added id field
    nlohmann::json add_event(Database &db, const nlohmann::json &event);
    // credentials and writing has to be checked before calling this function
    nlohmann::json update_event(Database &db, const nlohmann::json &event);

    // returns a json array with all events that are visible by the given person
    // note that the credentials check has to be done before
    nlohmann::json get_events(Database &db, std::string_view person);
    
    // returns a json object with the id, if the object exists and the user is allowed
    // ot see the event
    // else returns an empty object
    nlohmann::json get_event(Database &db, std::string_view person, uint64_t id);

    nlohmann::json delete_event(Database &db, std::string_view person, uint64_t id);

    void setup_timeclock_tables(Database &database);
}