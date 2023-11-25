#pragma once
#include "Database.hpp"
#include "numeric"

using OffsetSizes = std::vector<std::pair<uint64_t, uint64_t>>;

template<typename T>
uint64_t serialized_size(const T& data) {
    return data.size() * sizeof(data[0]);
}
template<> uint64_t serialized_size<std::vector<std::string>>(const std::vector<std::string>& data){
    return std::accumulate(data.begin(), data.end(), size_t{}, [](size_t a, const std::string& s){return a + s.length() + 1;});
}
template<> uint64_t serialized_size<std::vector<std::vector<std::byte>>>(const std::vector<std::vector<std::byte>>& data){
    return std::accumulate(data.begin(), data.end(), size_t{}, [](size_t a, const std::vector<std::byte>& e){return a + sizeof(uint64_t) + e.size();});
}

template<typename T>
void serialize_type(std::ofstream& data_file, const T& data){
    data_file.write(reinterpret_cast<const char*>(data.data()), data.size() * sizeof(data[0]));
}
template<> void serialize_type<std::vector<std::string>>(std::ofstream& data_file, const std::vector<std::string>& data){
    std::vector<char> d(serialized_size(data));
    size_t cur_offset{};
    for (const auto& s: data) {
        std::copy(s.data(), s.data() + s.length() + 1, d.data() + cur_offset);
        cur_offset += s.length() + 1;
    }
    serialize_type(data_file, d);
}
template<> void serialize_type<std::vector<std::vector<std::byte>>>(std::ofstream& data_file, const std::vector<std::vector<std::byte>>& data){
    std::vector<std::byte> d(serialized_size(data));
    size_t cur_offset{};
    for (const auto& e: data)  {
        reinterpret_cast<uint64_t&>(d[cur_offset]) = e.size();
        cur_offset += sizeof(uint64_t);
        std::copy(e.begin(), e.end(), d.begin() + cur_offset);
        cur_offset += e.size();
    }
    serialize_type(data_file, d);
}

template<typename T>
std::vector<T> deserialize_type(std::ifstream& data_file, const std::pair<uint64_t, uint64_t>& offset_size, uint64_t num_rows = 0){
    if (data_file.tellg() != offset_size.first)
        throw std::runtime_error{log_msg("The given data_file has its read pointer not at the offset value of offset_size")};
    std::vector<T> res(offset_size.second / sizeof(T));
    data_file.read(reinterpret_cast<char*>(res.data()), offset_size.second);
    return res;
}
template<> std::vector<std::string> deserialize_type<std::string>(std::ifstream& data_file, const std::pair<uint64_t, uint64_t>& offset_size, uint64_t num_rows){
    auto chars = deserialize_type<char>(data_file, offset_size);
    // parsing the strings
    std::vector<std::string> res(num_rows);
    size_t cur_offset{};
    for (auto i: i_range(num_rows)){
        res[i] = chars.data() + cur_offset;
        cur_offset += res[i].length() + 1;
    }
    if (cur_offset != chars.size())
        throw std::runtime_error{log_msg("Error at deserializing strings")};
    return res;
}
template<> std::vector<std::vector<std::byte>> deserialize_type<std::vector<std::byte>>(std::ifstream& data_file, const std::pair<uint64_t, uint64_t>& offset_size, uint64_t num_rows){
    auto bytes = deserialize_type<std::byte>(data_file, offset_size);
    // parsing the byte vectors
    std::vector<std::vector<std::byte>> res(num_rows);
    size_t cur_offset{};
    for (auto i: i_range(num_rows)) {
        uint64_t cur_size = reinterpret_cast<uint64_t&>(bytes[cur_offset]);
        cur_offset += sizeof(cur_size);
        res[i].resize(cur_size);
        std::copy(bytes.begin() + cur_offset, bytes.begin() + cur_offset + cur_size, res[i].begin());
        cur_offset += cur_size;
    }
    if (cur_offset != bytes.size())
        throw std::runtime_error{log_msg("Error at deserializing byte vectors")};
    return res;
}