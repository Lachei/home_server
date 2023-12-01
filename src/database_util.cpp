#include "database_util.hpp"
#include "AdminCredentials.hpp"
#include "string_split.hpp"

template <typename T>
static const std::string t = std::string(Database::column_type_name_v<T>);
using Date = Database::Date;
static Database::Table::ColumnInfos event_infos{
    .column_names = {"id", "title", "description", "start_time", "end_time", "creator", "people", "people_status", "visibility", "expected_hours", "progress"},
    .column_types = {t<uint64_t>, t<std::string>, t<std::string>, t<Date>, t<Date>, t<std::string>, t<std::string>, t<std::string>, t<std::string>, t<double>, t<double>},
    .id_column = 0};
static Database::Table::ColumnInfos active_timeclock_infos {
    .column_names = {"user", "start_time"},
    .column_types = {t<std::string>, t<Date>},
    .id_column = 0};
static Database::Table::ColumnInfos finished_timeclock_infos {
    .column_names = {"id", "user", "start_time", "end_time", "visibility", "original_start_time", "original_end_time"},
    .column_types = {t<uint64_t>, t<std::string>, t<Date>, t<Date>, t<std::string>, t<Date>, t<Date>},
    .id_column = 0};

std::vector<Database::ElementType> json_event_to_db_event(const nlohmann::json &event)
{
    const auto title = event["title"].get<std::string>();
    const auto description = event["description"].get<std::string>();
    const auto start_time = from_json_date_string(event["start_time"].get<std::string>());
    const auto end_time = from_json_date_string(event["end_time"].get<std::string>()); // time is always transmitted with a string
    const auto creator = event["creator"].get<std::string>();
    const auto people = std::string(json_array_remove_whitespace(event["people"].get<std::string>()));
    const auto people_status = std::string(json_array_remove_whitespace(event["people_status"].get<std::string>()));
    const auto visibility = event["visibility"].get<std::string>();
    const auto expected_hours = event["expected_hours"].get<double>();
    const auto progress = event["progress"].get<double>();

    return std::vector<Database::ElementType>{title, description, start_time, end_time, creator, people, people_status, visibility, expected_hours, progress};
}

nlohmann::json db_events_to_json_events(std::span<const Database::ColumnType> events)
{
    const auto data_size = std::visit([](auto &&v)
                                      { return v.size(); },
                                      events[0]);
    nlohmann::json res = std::vector<nlohmann::json>(data_size);
    for (auto i : i_range(data_size))
    {
        res[i]["id"] = std::get<std::vector<uint64_t>>(events[0])[i];
        res[i]["title"] = std::get<std::vector<std::string>>(events[1])[i];
        res[i]["description"] = std::get<std::vector<std::string>>(events[2])[i];
        res[i]["start_time"] = to_json_date_string(std::get<std::vector<Date>>(events[3])[i]);
        res[i]["end_time"] = to_json_date_string(std::get<std::vector<Date>>(events[4])[i]);
        res[i]["creator"] = std::get<std::vector<std::string>>(events[5])[i];
        res[i]["people"] = std::get<std::vector<std::string>>(events[6])[i];
        res[i]["people_status"] = std::get<std::vector<std::string>>(events[7])[i];
        res[i]["visibility"] = std::get<std::vector<std::string>>(events[8])[i];
        res[i]["expected_hours"] = std::get<std::vector<double>>(events[9])[i];
        res[i]["progress"] = std::get<std::vector<double>>(events[10])[i];
    }
    return res;
}

namespace database_util
{
    void setup_event_table(Database &database)
    {
        assert(event_infos.column_names.size() == event_infos.column_types.size());
        database.create_table(event_table_name, event_infos);
    }

    nlohmann::json add_event(Database &db, const nlohmann::json &event)
    {
        try
        {
            auto e = event;
            auto db_event = json_event_to_db_event(e);

            // getting all required parts of an event to create it
            const auto id = db.insert_row_without_id(event_table_name, db_event);
            db.store_table_caches();
            const auto inserted_event = db.query_database(Database::IDQuery{.table_name = std::string(event_table_name), .id = id});
            return db_events_to_json_events(inserted_event)[0]; // [0] is needed to unpack the 1 sized array that is returned from db_events_to.....
        }
        catch (const std::exception &e)
        {
            return nlohmann::json{{"error", e.what()}};
        }
        return nlohmann::json({"error", log_msg("Some other error occurred")});
    }

    nlohmann::json update_event(Database &db, const nlohmann::json &event)
    {
        try
        {
            const auto id = event["id"].get<uint64_t>();
            auto db_event = json_event_to_db_event(event);
            db_event.insert(db_event.begin(), Database::ElementType{id});
            db.update_row(event_table_name, db_event);
            db.store_table_caches();
            const auto updated_event = db.query_database(Database::IDQuery{.table_name = std::string(event_table_name), .id = id});
            return db_events_to_json_events(updated_event)[0]; // [0] is needed to unpack the 1 sized array
        }
        catch (const std::exception &e)
        {
            return nlohmann::json({"error", e.what()});
        }
        return nlohmann::json{{"error", log_msg("End of db_function, should never arrive here")}};
    }

    nlohmann::json get_events(Database &db, std::string_view person)
    {
        auto data = db.query_database(Database::EventQuery{.event_table_name = std::string(event_table_name),
                                                           .query_person = std::string(person)});
        return db_events_to_json_events(data);
    }

    nlohmann::json get_event(Database &db, std::string_view person, uint64_t id)
    {
        const auto user_allowed_to_see = [](std::string_view person, std::string_view list)
        {
            if (person == admin_name)
                return true;

            for (auto user : string_split{json_array_to_comma_list(list), std::string_view(",")})
                if (user == person || user == "Alle")
                    return true;
            return false;
        };
        try
        {
            const auto e = db.query_database(Database::IDQuery{.table_name = std::string(event_table_name), .id = id});
            const auto event = db_events_to_json_events(e)[0];
            if (!user_allowed_to_see(person, event["visibility"].get<std::string>()))
                return nlohmann::json{{"error", "The user is now permitted to see this event"}};
            return event;
        }
        catch (const std::exception &e)
        {
            return nlohmann::json{{"error", e.what()}};
        }
        return nlohmann::json{{"error", log_msg("Some other error occured")}};
    }

    nlohmann::json delete_event(Database &db, std::string_view person, uint64_t id)
    {
        try
        {
            const auto e = db.query_database(Database::IDQuery{.table_name = std::string(event_table_name), .id = id});
            if (std::get<std::vector<std::string>>(e[5])[0] != person && person != admin_name)
                return nlohmann::json{{"error", "Only the creator of the event and the admin can destroy the element"}};
            db.delete_row(event_table_name, id);
            db.store_table_caches();
            return nlohmann::json{{"success", "The element was successfully deleted"}};
        }
        catch (const std::exception &e)
        {
            return nlohmann::json({"error", e.what()});
        }
        return nlohmann::json({"error", log_msg("Should not get here")});
    }

    void setup_timeclock_tables(Database &database)
    {
        assert(active_timeclock_infos.column_names.size() == active_timeclock_infos.column_types.size());
        assert(finished_timeclock_infos.column_names.size() == finished_timeclock_infos.column_types.size());

        database.create_table(active_timeclock_table_name, active_timeclock_infos);
        database.create_table(finished_timeclock_table_name, finished_timeclock_infos);
    }
}