#include "database_util.hpp"

template <typename T>
static const std::string t = std::string(Database::column_type_name_v<T>);
using Date = Database::Date;
static Database::Table::ColumnInfos event_infos{
    .column_names = {"id"       , "title"       , "description" , "start_time", "end_time", "people"      , "visibility"  , "expected_hours", "progress"},
    .column_types = {t<uint64_t>, t<std::string>, t<std::string>, t<Date>     , t<Date>   , t<std::string>, t<std::string>, t<double>       , t<double>},
    .id_column = 0};
void setup_event_table(Database &database)
{
    assert(event_infos.column_names.size() == event_infos.column_types.size());
    database.create_table(event_table_name, event_infos);
}

nlohmann::json add_event(Database &db, const nlohmann::json &event)
{
    try
    {
        // getting all required parts of an event to create it
        const auto title = event["title"].get<std::string>();
        const auto description = event["description"].get<std::string>();
        const auto start_time = from_date_string(event["start_time"].get<std::string>());
        const auto end_time = from_date_string(event["end_time"].get<std::string>()); // time is always transmitted with a string
        const auto people = event["people"].get<std::string>();
        const auto visibility = event["visibility"].get<std::string>();
        const auto expected_hours = event["expected_hours"].get<float>(); 
        // no progress needed as it is assumed to be 0
        
        std::vector<Database::ElementType> new_event{ title, description, start_time, end_time, people, visibility, expected_hours, 0.0f};
        db.insert_row_without_id(event_table_name, new_event);
    }
    catch (std::runtime_error e)
    {
        return nlohmann::json{{"error", e.what()}};
    }
    catch (nlohmann::json::type_error e)
    {
        return nlohmann::json{{"error", std::string("Json missing parameter: "), e.what()}};
    }
    return {};
}