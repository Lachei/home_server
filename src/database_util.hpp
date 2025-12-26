#pragma once
#include "Database.hpp"
#include "nlohmann/json_fwd.hpp"

namespace database_util
{
    static constexpr std::string_view event_table_name = "events";
    static constexpr std::string_view active_shifts_table_name = "active_shifts";
    static constexpr std::string_view finished_shifts_table_name = "finished_shifts";

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

    void setup_shift_tables(Database &database);
    nlohmann::json start_shift(Database &db, std::string_view person, std::string_view comment = {});
    nlohmann::json check_active_shift(const Database &db, std::string_view person);
    nlohmann::json end_shift(Database &db, std::string_view person);
    // returns the shifts in a json object which contains for each user a list of shifts that user
    // has started and completed
    nlohmann::json get_shifts_grouped(Database &db);
    nlohmann::json get_shift(const Database &db, uint64_t shift_id);
    nlohmann::json update_shift(Database &db, const nlohmann::json &shift);
    nlohmann::json delete_shift(Database &db, std::string_view user, uint64_t shift_id);
    nlohmann::json add_shift(Database &db, const nlohmann::json &shift);
}
